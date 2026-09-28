# Saved prompts test cleanup

Pre-edit disposition recorded before source/test changes. This covers all 10 assigned files; completed implementation and validation are appended below. No behavior changes are intended.

## Retention contracts and six-bar justification

Every retained/reworked row below applies its named concrete input/result to one of these explicit contracts. The row name is the exact distinct failure being prevented; this is not a blanket designation for all tests in a file.

### dispatch

Failure modes considered before retaining isolated tests: Dispatch failures lose remote updates or mix unrelated events; only positive upsert/delete and wrong-channel isolation survive. Store tests intentionally bypass this channel owner.

1. Independent source: packages/api/src/saved-prompts.ts names channel saved-prompts and event types.
2. Observable failure: each retained case below identifies data, action, refusal, or lifecycle loss visible to that caller; no declaration comparison is retained.
3. Independent expectation: literal fixture values, selected IDs, fixed external answers and explicit success/refusal outcomes can disagree with code; no output is computed with the owner under test.
4. Stable seam: shared app applyEvent is the real stream dispatch interface used by app clients.
5. Refactor tolerance: only semantic results or boundary effects are retained; source names, markup, private collection identity and scheduling shape are excluded.
6. Lowest owner / stronger coverage: Dispatch failures lose remote updates or mix unrelated events; only positive upsert/delete and wrong-channel isolation survive. Store tests intentionally bypass this channel owner. API/store/widget layers that do not own this state transition cannot replace it; named duplicates are deleted or relocated below.

### list

Failure modes considered before retaining isolated tests: Failures: wrong project visible, matching prompt hidden, cross-field query lost, non-ASCII search fails, edited prompt search stays stale. Retained scope and search cases observe IDs, not sorting or markup.

1. Independent source: feature commit e1181acb specifies searchable global/project prompts; SavedPromptsPanel search control and All/Project selector implement it. The API SavedPrompt.pinned comment requires favorites in the first Pinned section, and the list route specifies global/project scoping.
2. Observable failure: each retained case below identifies data, action, refusal, or lifecycle loss visible to that caller; no declaration comparison is retained.
3. Independent expectation: literal fixture values, selected IDs, fixed external answers and explicit success/refusal outcomes can disagree with code; no output is computed with the owner under test.
4. Stable seam: promptsForProject used by hooks and savedPromptSections used by panel.
5. Refactor tolerance: only semantic results or boundary effects are retained; source names, markup, private collection identity and scheduling shape are excluded.
6. Lowest owner / stronger coverage: Failures: wrong project visible, matching prompt hidden, cross-field query lost, non-ASCII search fails, edited prompt search stays stale. Retained scope and search cases observe IDs, not sorting or markup. API/store/widget layers that do not own this state transition cannot replace it; named duplicates are deleted or relocated below.

### store

Failure modes considered before retaining isolated tests: Failures: malformed wire poisoning, dropped/newly resurrected records, cross-project replacement, cross-connection leakage, stale reconnect answer, unbounded retry, optimistic pin rollback/race, lost mutation errors. Fake API supplies external answers; real store owns merging, generation, recovery and notifications.

1. Independent source: API saved-prompt events/routes and AGENTS wire validation/connection isolation; concrete stale-response, reconnect and optimistic-update regression scenarios.
2. Observable failure: each retained case below identifies data, action, refusal, or lifecycle loss visible to that caller; no declaration comparison is retained.
3. Independent expectation: literal fixture values, selected IDs, fixed external answers and explicit success/refusal outcomes can disagree with code; no output is computed with the owner under test.
4. Stable seam: store actions and subscribed state used by hooks, SavedPromptsPanel, SavedPromptEditor and app stream callbacks.
5. Refactor tolerance: only semantic results or boundary effects are retained; source names, markup, private collection identity and scheduling shape are excluded.
6. Lowest owner / stronger coverage: Failures: malformed wire poisoning, dropped/newly resurrected records, cross-project replacement, cross-connection leakage, stale reconnect answer, unbounded retry, optimistic pin rollback/race, lost mutation errors. Fake API supplies external answers; real store owns merging, generation, recovery and notifications. API/store/widget layers that do not own this state transition cannot replace it; named duplicates are deleted or relocated below.

### variables

Failure modes considered before retaining isolated tests: Failures: no-chat adapter leaks stale model/agent, registry/catalog fallback loses label; shared cases detect wrong branch/file/patch context. Shared formatters are moved to their lowest owner rather than duplicated.

1. Independent source: API saved-prompts.ts variable definitions and prompt-variables resolver contract; context.ts binds active chat identity.
2. Observable failure: each retained case below identifies data, action, refusal, or lifecycle loss visible to that caller; no declaration comparison is retained.
3. Independent expectation: literal fixture values, selected IDs, fixed external answers and explicit success/refusal outcomes can disagree with code; no output is computed with the owner under test.
4. Stable seam: resolveSavedPrompt used by SavedPromptsPanel; agentLabelFor/modelLabelFor used by context.ts; moved formatter cases use API resolvePromptVariables.
5. Refactor tolerance: only semantic results or boundary effects are retained; source names, markup, private collection identity and scheduling shape are excluded.
6. Lowest owner / stronger coverage: Failures: no-chat adapter leaks stale model/agent, registry/catalog fallback loses label; shared cases detect wrong branch/file/patch context. Shared formatters are moved to their lowest owner rather than duplicated. API/store/widget layers that do not own this state transition cannot replace it; named duplicates are deleted or relocated below.

### delivery

Failure modes considered before retaining isolated tests: Failures: wrong chat receives resolved content, stale click sends after newer click/unmount, missing target sends anyway, refusal increments usage. Fakes record terminal effects; they do not implement cancellation or target validation.

1. Independent source: SavedPromptsPanel Insert/Send actions target visible session and API used counter counts successful delivery; concrete async tab-switch/supersession regression.
2. Observable failure: each retained case below identifies data, action, refusal, or lifecycle loss visible to that caller; no declaration comparison is retained.
3. Independent expectation: literal fixture values, selected IDs, fixed external answers and explicit success/refusal outcomes can disagree with code; no output is computed with the owner under test.
4. Stable seam: createSavedPromptDeliverer used directly by SavedPromptsPanel to implement action transaction.
5. Refactor tolerance: only semantic results or boundary effects are retained; source names, markup, private collection identity and scheduling shape are excluded.
6. Lowest owner / stronger coverage: Failures: wrong chat receives resolved content, stale click sends after newer click/unmount, missing target sends anyway, refusal increments usage. Fakes record terminal effects; they do not implement cancellation or target validation. API/store/widget layers that do not own this state transition cannot replace it; named duplicates are deleted or relocated below.

### save

Failure modes considered before retaining isolated tests: Failures: duplicate create, invalid write, unchanged edit sends destructive data, late success disappears, late refusal becomes invisible, failed request locks future saves. Deferred boundary replies test transaction lifecycle, not rendering.

1. Independent source: SavedPromptEditor permits closing in-flight saves and API creates are non-idempotent; patch API preserves omitted fields.
2. Observable failure: each retained case below identifies data, action, refusal, or lifecycle loss visible to that caller; no declaration comparison is retained.
3. Independent expectation: literal fixture values, selected IDs, fixed external answers and explicit success/refusal outcomes can disagree with code; no output is computed with the owner under test.
4. Stable seam: createSavedPromptSaver used by SavedPromptEditor for save lifecycle.
5. Refactor tolerance: only semantic results or boundary effects are retained; source names, markup, private collection identity and scheduling shape are excluded.
6. Lowest owner / stronger coverage: Failures: duplicate create, invalid write, unchanged edit sends destructive data, late success disappears, late refusal becomes invisible, failed request locks future saves. Deferred boundary replies test transaction lifecycle, not rendering. API/store/widget layers that do not own this state transition cannot replace it; named duplicates are deleted or relocated below.

### editor

Failure modes considered before retaining isolated tests: Failures: invalid wire bounds accepted, untouched remote fields overwritten, project silently moved, damaged Unicode copied title, selected body text lost. Static expected requests and text are independent of helper implementation.

1. Independent source: packages/api/src/saved-prompts.ts request fields, UTF-16 limits and partial-update preservation; SavedPromptEditorForm variable chip uses textarea selection.
2. Observable failure: each retained case below identifies data, action, refusal, or lifecycle loss visible to that caller; no declaration comparison is retained.
3. Independent expectation: literal fixture values, selected IDs, fixed external answers and explicit success/refusal outcomes can disagree with code; no output is computed with the owner under test.
4. Stable seam: createRequestFromDraft/updatePatchFromDraft consumed by saver, validateSavedPromptDraft by form and saver, duplicateRequest by panel, insertAtSelection by form.
5. Refactor tolerance: only semantic results or boundary effects are retained; source names, markup, private collection identity and scheduling shape are excluded.
6. Lowest owner / stronger coverage: Failures: invalid wire bounds accepted, untouched remote fields overwritten, project silently moved, damaged Unicode copied title, selected body text lost. Static expected requests and text are independent of helper implementation. API/store/widget layers that do not own this state transition cannot replace it; named duplicates are deleted or relocated below.

## Per-case pre-edit ledger

Risk: DELETE removes only the stated invalid observation or a named duplicate. KEEP/REWRITE risk is loss of its concrete regression if altered; all remaining cases run with the UI package import hooks. API relocations run with the API package hook. No live service is started.

Validation U: `cd packages/ui && pnpm exec node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/svg-loader.mjs --import ./test/quiet-mock-timers.mjs --test src/lib/saved-prompts/*.test.ts src/components/right-rail/saved-prompts/*.test.ts`.

Validation A: `cd packages/api && pnpm exec node --import tsx --import ../../scripts/test/assert-ok.mjs --test src/prompt-variable-values.test.ts`.

### `packages/ui/src/components/right-rail/saved-prompts/deliver.test.ts`

| Disposition | Original case / detected failure | Reason, remaining coverage and bar contract |
| --- | --- | --- |
| REWRITE | L65: renders for the chat captured at the click, delivers there, and counts the use | Exercise both insert and send with fixed rendered content, delivery outcome and use count, without generated fake rendering. Six-bar contract: delivery; no stronger owner for remaining distinction. |
| DELETE | L76: Send goes through the send path | Single send-call count duplicates rewritten insert/send delivery boundary case. |
| REWRITE | L84: refuses when another chat is on screen once the prompt is rendered — nothing lands, nothing counted | Table covers changed and absent active chat; assert refusal and no delivery/accounting, not production reason constant. Six-bar contract: delivery; no stronger owner for remaining distinction. |
| DELETE | L96: refuses when no chat is on screen at all by the time it is rendered | Merged into changed-target refusal table (new chat and no chat). |
| REWRITE | L105: with no chat at the click, refuses at once and renders nothing | Assert refused state/no resolution rather than comparing imported reason declaration. Six-bar contract: delivery; no stronger owner for remaining distinction. |
| KEEP | L114: a click supersedes the one still resolving: the first lands nowhere, its git reads stop | Six-bar contract: delivery; exact failure is the named case. No stronger owner covers this transition. |
| KEEP | L137: dispose (the panel going away) stops the delivery in flight | Six-bar contract: delivery; exact failure is the named case. No stronger owner covers this transition. |
| KEEP | L149: counts the use only when the chat took it | Six-bar contract: delivery; exact failure is the named case. No stronger owner covers this transition. |
| DELETE | L176: a Send that switched the chat's mode is a delivery too | Success-disposition echo repeats success accounting; chat-target owns mode-command semantics. |

### `packages/ui/src/components/right-rail/saved-prompts/editor-bridge.test.ts`

| Disposition | Original case / detected failure | Reason, remaining coverage and bar contract |
| --- | --- | --- |
| DELETE | L12: with no editor host, opening reports false | Empty listener-count probe is private bus mechanics, not proof the fallback editor opens. |
| DELETE | L16: a host takes the request, and unsubscribing takes it out | Callback echo/unsubscribe shape does not exercise mounted editor workflow; bus still required by real hosts. |

### `packages/ui/src/components/right-rail/saved-prompts/editor-save.test.ts`

| Disposition | Original case / detected failure | Reason, remaining coverage and bar contract |
| --- | --- | --- |
| DELETE | L77: a create sends the record, and reveals what the daemon answered | Stub return echo and request title duplicate request serialization/store synchronization owners. |
| KEEP | L87: an edit that changes nothing sends nothing, and closes | Six-bar contract: save; exact failure is the named case. No stronger owner covers this transition. |
| DELETE | L96: an edit sends only what changed | Duplicate editor.logic.test.ts changed-field API patch contract. |
| KEEP | L103: an invalid draft is not sent | Six-bar contract: save; exact failure is the named case. No stronger owner covers this transition. |
| KEEP | L109: one save at a time: a second while the first is in flight is not sent | Six-bar contract: save; exact failure is the named case. No stronger owner covers this transition. |
| DELETE | L122: a refusal while the editor is open is the form's to show | Injected refusal echo duplicates late-failure/rejection cases; no form is exercised. |
| KEEP | L131: closed while saving: a success still lands and is revealed | Six-bar contract: save; exact failure is the named case. No stronger owner covers this transition. |
| KEEP | L144: closed while saving: a failure becomes the panel's notice | Six-bar contract: save; exact failure is the named case. No stronger owner covers this transition. |
| KEEP | L155: a request that throws is a failure, and the guard is released | Six-bar contract: save; exact failure is the named case. No stronger owner covers this transition. |

### `packages/ui/src/components/right-rail/saved-prompts/editor.logic.test.ts`

| Disposition | Original case / detected failure | Reason, remaining coverage and bar contract |
| --- | --- | --- |
| DELETE | L49: splits on commas, trims, collapses spaces, drops empties and repeats | Standalone tag parser duplicate of rewritten create API request case. |
| DELETE | L56: edit: the prompt as it is | Object projection restates draft representation with expected fields taken from fixture. |
| DELETE | L68: create: the prefill, global unless a project scope can be had | Private draft shape/prefill projection; no user save-as-prompt workflow exercised. |
| DELETE | L88: 'This project' is offered with an open project, or for a prompt already in one | Boolean projection of request shape; no actual offered control is exercised. |
| KEEP | L100: a title and a body are required — as missing, not as errors | Six-bar contract: editor; exact failure is the named case. No stronger owner covers this transition. |
| REWRITE | L108: mirrors every limit | Assert field error presence and literal boundary validity rather than exact UI copy. Six-bar contract: editor; no stronger owner for remaining distinction. |
| REWRITE | L132: a create: the whole record, normalised; This project = the open project | Include malformed tag whitespace/duplicates in create request; absorb private parser case. Six-bar contract: editor; no stronger owner for remaining distinction. |
| KEEP | L157: an edit: only the fields that changed | Six-bar contract: editor; exact failure is the named case. No stronger owner covers this transition. |
| KEEP | L170: an edit moves a prompt only when its scope changes — and to the open project | Six-bar contract: editor; exact failure is the named case. No stronger owner covers this transition. |
| DELETE | L189: adds (copy) and keeps it within the title limit | Exact copy suffix is presentation copy, with size/Unicode contract retained through duplicate request. |
| REWRITE | L196: never cuts an emoji in half | Observe valid bounded Unicode title through production duplicateRequest, remove private helper seam and redundant suffix/length assertions. Six-bar contract: editor; no stronger owner for remaining distinction. |
| DELETE | L210: opens a prefilled create in the prompt's own scope | Fixture-to-object projection and reference inequality test internal allocation, not independent behavior. |
| REWRITE | L229: inserts at the caret, or over the selection, and puts the caret after it | Keep real caret/selection text edits; drop undocumented invalid selection arithmetic. Six-bar contract: editor; no stronger owner for remaining distinction. |

### `packages/ui/src/components/right-rail/saved-prompts/list-focus.test.ts`

| Disposition | Original case / detected failure | Reason, remaining coverage and bar contract |
| --- | --- | --- |
| DELETE | L8: nothing to do when focus was not on a card | Private focus-plan shape; browser focus is never observed. |
| DELETE | L12: a card still listed keeps focus; a move asks to keep it in view | Private focus/scroll plan shape; browser focus is never observed. |
| DELETE | L20: a card that went away hands focus to the next one, else the previous one | Private neighbor plan shape; browser focus is never observed. |
| DELETE | L27: the last card gone: the list itself | Private fallback plan shape; browser focus is never observed. |
| DELETE | L34: wrap around, and Home / End jump | Private index arithmetic; keyboard interaction/focus is never observed. |
| DELETE | L43: from the panel itself: down to the first, up to the last | Private index arithmetic; keyboard interaction/focus is never observed. |
| DELETE | L48: other keys, or no items, are left alone | Private no-op projection; keyboard interaction/focus is never observed. |

### `packages/ui/src/lib/saved-prompts/app-wiring.test.ts`

| Disposition | Original case / detected failure | Reason, remaining coverage and bar contract |
| --- | --- | --- |
| REWRITE | L46: an upsert and a delete on the saved-prompts channel reach the store | Send literal protocol channel `saved-prompts`, not the production constant; otherwise a coordinated wrong-channel rename would pass. Six-bar contract: dispatch; no stronger owner exercises app event dispatch. |
| KEEP | L56: the same message on another channel does not | Six-bar contract: dispatch; exact failure is the named case. No stronger owner covers this transition. |
| DELETE | L62: a malformed payload is ignored without a throw | Malformed payload rejection is owned by store.test.ts malformed event and wire-validation cases. |
| DELETE | L90: ${name} resets them before it switches the client [signOut, selectConnection] | Source greps for signOut/selectConnection and ordering cannot prove reset, and break on identifier-only rename; store reset races remain. |

### `packages/ui/src/lib/saved-prompts/list.logic.test.ts`

| Disposition | Original case / detected failure | Reason, remaining coverage and bar contract |
| --- | --- | --- |
| DELETE | L41: strips trailing separators and keeps the root | Normalization internals duplicate scope behavior and API normalize owner. |
| DELETE | L49: a prompt belongs to a project whatever trailing slash either side has | Private membership helper duplicates retained scope selection. |
| KEEP | L65: the project can use every global prompt and its own, never another project's | Six-bar contract: list; exact failure is the named case. No stronger owner covers this transition. |
| REWRITE | L70: All is global + this project's; Project is this project's only | Exercise scope through production savedPromptSections, not private promptsInScope. Six-bar contract: list; no stronger owner for remaining distinction. |
| DELETE | L78: folds case and accents | Private folding representation duplicates retained user search results. |
| REWRITE | L84: folds the letters no decomposition takes apart: ł, ø, ß and their capitals | Assert ASCII query finds non-ASCII title/tags through production list selection; remove folded-string representation checks. Six-bar contract: list; no stronger owner for remaining distinction. |
| REWRITE | L94: matches title, description, tags and body, case- and accent-insensitively | Assert selected prompt IDs through production list selection; remove private search helper calls. Six-bar contract: list; no stronger owner for remaining distinction. |
| REWRITE | L108: every word must match, each anywhere | Assert selected IDs for multi-word/blank query through production list selection. Six-bar contract: list; no stronger owner for remaining distinction. |
| REWRITE | L115: an edited record is searched by its new text | Assert edited record search results through production list selection. Six-bar contract: list; no stronger owner for remaining distinction. |
| REWRITE | L138: pinned first, alphabetical (case-insensitive, numeric-aware) | API SavedPrompt.pinned independently specifies the Pinned section. Preserve favorite membership through savedPromptSections; delete exact alphabetical/numeric presentation order. Six-bar contract: list. No other test owns section selection. |
| DELETE | L143: the rest: last used first, never used after, then last edited, then title | Exact multi-key presentation order has no independent requirement; retained store cases protect usage data. |
| DELETE | L149: the search filters both sections; inScope counts before it | Section shape/count probe duplicates retained scope and search results. |
| DELETE | L158: names the git context a body reads, in first-use order | Presentation copy and order, with parsing owned by packages/api/src/saved-prompts.test.ts. |
| DELETE | L164: is absent without git variables — other variables and escapes do not count | Presentation absence duplicates API known-variable/escape parser contract. |
| DELETE | L172: says refresh only for rows that were loaded | Exact presentation-copy distinction is not a contract; store retains load/refresh error state. |
| DELETE | L188: rows win over every empty state | Private view-model discriminator precedence, not an observed user workflow. |
| DELETE | L194: loading, then a load error, then the scope's own emptiness | Private empty-state inventory, not an observed user workflow. |
| DELETE | L206: a search with nothing matching says so, with the query as typed | Private view-model shape/copy, not an observed user search result. |

### `packages/ui/src/lib/saved-prompts/store.test.ts`

| Disposition | Original case / detected failure | Reason, remaining coverage and bar contract |
| --- | --- | --- |
| REWRITE | L156: repairs optional fields and refuses what cannot be trusted | Exercise malformed wire rows through applySavedPromptEvent, the production event boundary; make sanitizer private. Six-bar contract: store; no stronger owner for remaining distinction. |
| REWRITE | L190: loads global + the project's, once, sharing a request between concurrent callers | Rename to request-sharing behavior and remove fake-server scoping claim; real scope selection tested separately. Six-bar contract: store; no stronger owner for remaining distinction. |
| KEEP | L208: no project loads the global list alone | Six-bar contract: store; exact failure is the named case. No stronger owner covers this transition. |
| KEEP | L216: a reload replaces exactly its scope: what the daemon dropped goes, another project's stays | Six-bar contract: store; exact failure is the named case. No stronger owner covers this transition. |
| KEEP | L231: an event that overtakes the load answer it is newer than survives the answer | Six-bar contract: store; exact failure is the named case. No stronger owner covers this transition. |
| KEEP | L244: an answer never brings back a prompt deleted meanwhile, nor overwrites a newer copy | Six-bar contract: store; exact failure is the named case. No stronger owner covers this transition. |
| KEEP | L263: an id nothing touched during the load takes the answer as-is, even stamped older | Six-bar contract: store; exact failure is the named case. No stronger owner covers this transition. |
| DELETE | L275: a reload that changes nothing keeps every record's object | Record reference identity is an implementation optimization, not caller-visible data. |
| KEEP | L284: a first load that fails is an error; a failed refresh keeps the rows beside the error | Six-bar contract: store; exact failure is the named case. No stronger owner covers this transition. |
| REWRITE | L303: a forced load asked while one is in flight asks again after it — once, for every such call | Drop Promise object identity; preserve exactly one follow-up and newest records. Six-bar contract: store; no stronger owner for remaining distinction. |
| REWRITE | L323: a project list the daemon refuses (400) falls back to the global list, and says why | Keep fallback/global records/error state; replace exact advice copy with source error data. Six-bar contract: store; no stronger owner for remaining distinction. |
| KEEP | L347: any other failure of a project list does not fall back | Six-bar contract: store; exact failure is the named case. No stronger owner covers this transition. |
| DELETE | L355: a daemon without the route says so | Exact upgrade advice is presentation copy; retained malformed/error cases protect load refusal. |
| KEEP | L362: an answer of the wrong shape is a load error, not a crash | Six-bar contract: store; exact failure is the named case. No stronger owner covers this transition. |
| KEEP | L372: a malformed row is dropped, the rest of the answer kept | Six-bar contract: store; exact failure is the named case. No stronger owner covers this transition. |
| KEEP | L382: stale marks a reconnect: the rows stay and the next load refreshes in the background | Six-bar contract: store; exact failure is the named case. No stronger owner covers this transition. |
| REWRITE | L400: a load that crosses a reconnect asks once more, then is fresh | Drop Promise identity; keep recovered data and bounded refresh. Six-bar contract: store; no stronger owner for remaining distinction. |
| KEEP | L421: a failed load that crossed a reconnect retries once, not forever | Six-bar contract: store; exact failure is the named case. No stronger owner covers this transition. |
| DELETE | L439: an upsert is idempotent: the same record twice changes nothing | State reference identity is implementation coupling; mutation/event convergence remains. |
| KEEP | L448: an older record never replaces a newer one; a later use does | Six-bar contract: store; exact failure is the named case. No stronger owner covers this transition. |
| KEEP | L471: a delete removes, and nothing brings the id back | Six-bar contract: store; exact failure is the named case. No stronger owner covers this transition. |
| REWRITE | L480: malformed payloads and unknown types are ignored without a throw | Keep held records, remove state object identity. Six-bar contract: store; no stronger owner for remaining distinction. |
| DELETE | L494: a create applies the daemon's record at once; its own event later changes nothing | Expected ID comes from the function result and identity repeats the removed optimization probe; update/delete and race cases protect synchronization. |
| REWRITE | L506: an update applies its answer; a delete removes and tombstones | Use fixed update answer instead of fake server implementing the update under assertion. Six-bar contract: store; no stronger owner for remaining distinction. |
| REWRITE | L520: a failed change becomes the notice and reloads every loaded scope | Assert source error data, reload and dismissal, not fixed notice copy. Six-bar contract: store; no stronger owner for remaining distinction. |
| DELETE | L534: a notice can come from outside — an editor closed while it saved — and be dismissed | Setter/getter echo adds no independent behavior; late failure and notice recovery have retained owner cases. |
| KEEP | L541: a quiet failure leaves the notice to the caller | Six-bar contract: store; exact failure is the named case. No stronger owner covers this transition. |
| KEEP | L549: a pin shows at once, then carries the daemon's record | Six-bar contract: store; exact failure is the named case. No stronger owner covers this transition. |
| REWRITE | L566: a refused pin falls back to the held value, with the notice | Assert rollback and source refusal data rather than fixed notice wording. Six-bar contract: store; no stronger owner for remaining distinction. |
| KEEP | L578: two quick flips: only the latest answer clears the flip | Six-bar contract: store; exact failure is the named case. No stronger owner covers this transition. |
| REWRITE | L601: a use bumps the record; a failed bump is silent and reloads nothing | Keep successful answer synchronization with fixed answer and silent failed accounting; remove fake implementing increment. Six-bar contract: store; no stronger owner for remaining distinction. |
| KEEP | L617: forgets everything, and an answer from before it is dropped | Six-bar contract: store; exact failure is the named case. No stronger owner covers this transition. |
| KEEP | L637: a reset before the request left sends nothing | Six-bar contract: store; exact failure is the named case. No stronger owner covers this transition. |
| KEEP | L646: a client of another connection starts over | Six-bar contract: store; exact failure is the named case. No stronger owner covers this transition. |
| KEEP | L657: a mutation answered after a reset is not applied | Six-bar contract: store; exact failure is the named case. No stronger owner covers this transition. |

### `packages/ui/src/lib/saved-prompts/variables.test.ts`

| Disposition | Original case / detected failure | Reason, remaining coverage and bar contract |
| --- | --- | --- |
| DELETE | L76: names the project and workspace from the store, else from the path | Project/path substitution belongs to API resolver; API renders every variable retains shared contract. |
| DELETE | L94: renders the local date and time, zero-padded, 24 h | Duplicate API local-clock and timezone cases. |
| DELETE | L101: renders the chat's agent and model | Echoed labels duplicate API renders every variable; null-session adapter distinction remains. |
| KEEP | L108: renders both as empty without a target chat | Six-bar contract: variables; exact failure is the named case. No stronger owner covers this transition. |
| KEEP | L115: labels an agent by its registry name and a model by its catalogue name, else the raw id | Six-bar contract: variables; exact failure is the named case. No stronger owner covers this transition. |
| REWRITE | L131: {branch}: the branch, detached, or no repository | Move unique detached/no-repository outputs to packages/api/src/prompt-variable-values.test.ts at resolvePromptVariables; drop duplicate main-branch baseline. Six-bar contract: variables; no stronger owner for remaining distinction. |
| REWRITE | L139: {changedFiles}: one line per file, renames with both paths | Move rename/status/path output to API resolver owner. Six-bar contract: variables; no stronger owner for remaining distinction. |
| REWRITE | L157: {changedFiles}: clean, not a repo, and capped | Move no-repo/500-file cap to API resolver; expected bound literal 501, not imported implementation constant; clean-files baseline already belongs to API renders-every-variable. Six-bar contract: variables; no stronger owner for remaining distinction. |
| REWRITE | L172: {diff}: the patch, then the cut, then the untracked files | Move truncated patch/untracked result to API resolver; remove private API call-shape assertion. Six-bar contract: variables; no stronger owner for remaining distinction. |
| REWRITE | L189: {diff}: the patch alone, untracked alone, clean, and not a repo | Move untracked-only/clean/no-repo output to API resolver; patch-only baseline already belongs to API renders-every-variable. Six-bar contract: variables; no stronger owner for remaining distinction. |
| DELETE | L199: no project open reads as no repository, and asks git nothing | Duplicate API no-project resolver contract. |
| DELETE | L210: no git variable: git is never asked | Call inventory duplicates API owner and is not an additional result contract. |
| DELETE | L217: {branch} and {changedFiles} share one status read; no diff read | Private fetch count/order, not distinct rendered behavior. |
| DELETE | L224: {diff} alone reads only the diff | Private collaborator call inventory, not distinct rendered behavior. |
| DELETE | L231: an escaped {{diff}} is text, not a read | Escaped token parsing belongs to packages/api/src/saved-prompts.test.ts and API escaped workflow-expression case. |
| DELETE | L237: status and diff are read in parallel, with the caller's signal | Parallel scheduling and signal identity are collaborator shape; API cancellation result remains. |
| DELETE | L264: unknown names and code braces stay as written | Unknown-variable parsing belongs to packages/api/src/saved-prompts.test.ts. |
| DELETE | L273: a failed git read resolves nothing, and says why | Duplicate API names the failed read and variables contract. |
| DELETE | L303: an aborted resolve answers nothing to deliver | Weaker than API cancellation result (UI checked only false, any error could pass). |

### `packages/ui/src/components/right-rail/saved-prompts/saved-prompts-render.check.ts` — DELETE all standalone assertions

Static HTML is produced from manually supplied props, with every action replaced by noop. The following inventory records every original assertion statement (including parameterized families). No click, focus, save, send, screen-reader announcement or async workflow is exercised. Appearance, geometry and exact copy have no independent visual-regression requirement. Behavioral state is owned by retained store/delivery/save/serialization cases; API variable parsing is already tested at its owner. Production view components are real panel/editor dependencies and remain. Risk: no presentation snapshot coverage remains; no asserted workflow is lost. Validation U and root typecheck/build gates apply.

| Original line | DELETE observation |
| --- | --- |
| 146 | `assert.ok(start >= 0, ′a card for ${id}′);` |
| 157 | `assert.ok(panel.startsWith('<div class="flex min-h-0 flex-1 flex-col">'), "fills the dock and scrolls itself");` |
| 158 | `assert.ok(panel.includes('placeholder="Search prompts…"'), "the search field");` |
| 159 | `assert.ok(panel.includes('aria-label="Search saved prompts"'));` |
| 160 | `assert.ok(buttonWith(panel, "All").includes('aria-pressed="true"'), "All is the scope");` |
| 161 | `assert.ok(!DISABLED_ATTR.test(buttonWith(panel, "Project")), "Project is offered with a project open");` |
| 162 | `assert.ok(panel.includes(">Pinned</div>"), "the Pinned section");` |
| 163 | `assert.ok(panel.includes(">Prompts</div>"), "then the rest");` |
| 164 | `assert.ok( panel.indexOf(">Pinned</div>") < panel.indexOf("Review current changes") && panel.indexOf("Review current changes") < panel.indexOf(">Prompts</div>"), "the pinned card sits under Pinned, above the rest" );` |
| 171 | `assert.deepEqual([...order].sort((a, b) => a - b), order, "Plan (used) → Create a handoff → Fix failing tests");` |
| 175 | `assert.ok(card.includes("Review current changes"));` |
| 176 | `assert.ok(card.includes('aria-expanded="true"'), "its header collapses it");` |
| 178 | `assert.ok(star.includes('aria-pressed="true"'), "the star is pressed for a pinned prompt");` |
| 179 | `assert.ok(star.includes("fill-neutral-300"), "and filled");` |
| 180 | `assert.ok(star.includes('title="Pin"') && !card.includes("Unpin"), "one stable label, the state is aria-pressed");` |
| 181 | `assert.ok(star.includes("h-6 w-6"), "docked: a 24px target");` |
| 182 | `assert.ok(card.includes("data-card-focus"), "the header stands for the card when focus lands on it");` |
| 183 | `assert.ok( panel.includes('tabindex="-1" aria-label="Saved prompts" class="min-h-0 flex-1'), "the list itself can take focus (the last card gone)" );` |
| 187 | `assert.ok(card.includes("More actions for Review current changes"), "the actions menu");` |
| 188 | `assert.ok(card.includes(">Review</span>"), "the tag chip");` |
| 189 | `assert.ok(card.includes("Global</span>"), "the scope chip");` |
| 190 | `assert.ok(card.includes("Prioritize findings by severity."), "the description");` |
| 191 | `assert.ok(card.includes("Context: current diff, branch"), "the context the body reads");` |
| 194 | `assert.ok(!DISABLED_ATTR.test(insert) && !DISABLED_ATTR.test(send), "both enabled with a chat");` |
| 195 | `assert.ok(insert.includes("bg-neutral-200"), "Insert is the primary, filled button");` |
| 196 | `assert.ok(send.includes("border-neutral-700"), "Send is the outline one");` |
| 197 | `assert.ok(send.includes("lucide-arrow-up-right"), "Send ↗");` |
| 198 | `assert.ok(card.includes("grid grid-cols-2"), "side by side");` |
| 202 | `assert.ok(row.includes("Plan before coding"));` |
| 203 | `assert.ok(row.includes("Explore the codebase and propose a plan"), "its one-line description");` |
| 205 | `assert.ok(!rowBody.includes("Insert"), "clicking the row never inserts");` |
| 206 | `assert.ok(!DISABLED_ATTR.test(rowBody));` |
| 207 | `assert.ok(rowBody.includes('aria-expanded="false"'), "the whole row is one button, and expands");` |
| 208 | `assert.ok(rowBody.includes("lucide-chevron-right"), "the chevron is inside it");` |
| 209 | `assert.equal((row.match(/<button\b/g) ?? []).length, 1, "one button per collapsed row");` |
| 210 | `assert.ok(!row.includes(">Insert</button>"), "a collapsed row has no Insert/Send buttons");` |
| 211 | `assert.ok(!panel.includes(NO_CHAT_TARGET_REASON), "no no-chat hint while a chat is the target");` |
| 215 | `assert.ok(newPrompt.includes("lucide-plus") && newPrompt.includes("w-full"), "+ New prompt, full width");` |
| 216 | `assert.ok(newPrompt.includes("bg-neutral-200"), "filled, like Insert");` |
| 217 | `assert.ok(panel.includes("Open a prompt to insert or send it"), "the hint under it");` |
| 218 | `assert.ok( panel.lastIndexOf("New prompt") > panel.lastIndexOf("data-saved-prompt="), "the footer is below the list" );` |
| 227 | `assert.ok(cardOf(pinnedRow, REVIEW.id).includes("fill-neutral-500"), "a pinned row shows a muted star");` |
| 228 | `assert.ok(cardOf(pinnedRow, REVIEW.id).includes("(pinned)"));` |
| 235 | `assert.ok(noChat.includes(NO_CHAT_TARGET_REASON), "the list says why");` |
| 236 | `assert.ok( noChat.indexOf(NO_CHAT_TARGET_REASON) < noChat.indexOf("data-saved-prompt="), "above the prompts" );` |
| 241 | `assert.ok(DISABLED_ATTR.test(buttonWith(noChatCard, "Insert")), "Insert disabled");` |
| 242 | `assert.ok(DISABLED_ATTR.test(buttonWith(noChatCard, "Send")), "Send disabled");` |
| 243 | `assert.ok(!DISABLED_ATTR.test(buttonWith(cardOf(noChat, PLAN.id), "Plan before coding")), "a row still opens");` |
| 244 | `assert.ok(!DISABLED_ATTR.test(buttonWith(noChat, "New prompt")), "and a prompt can still be written");` |
| 255 | `assert.ok(buttonWith(busyCard, "Send").includes("animate-spin"), "a spinner on the pressed button");` |
| 256 | `assert.ok(!buttonWith(busyCard, "Insert").includes("animate-spin"), "only there");` |
| 259 | `assert.ok(button.includes(ARIA_DISABLED), ′${label} refuses clicks meanwhile′);` |
| 260 | `assert.ok(!DISABLED_ATTR.test(button), ′${label} is never \′disabled\′ for it: that would drop its focus′);` |
| 261 | `assert.ok(button.includes("aria-disabled:opacity-50"), ′${label} still looks disabled′);` |
| 263 | `assert.ok(!DISABLED_ATTR.test(buttonWith(cardOf(busy, PLAN.id), "Plan before coding")), "other prompts stay usable");` |
| 264 | `assert.ok(!buttonWith(cardOf(busy, PLAN.id), "Plan before coding").includes(ARIA_DISABLED));` |
| 270 | `assert.ok(!DISABLED_ATTR.test(busyRowBody), "a row resolving still opens");` |
| 271 | `assert.ok(busyRowBody.includes("animate-spin"));` |
| 279 | `assert.ok(cardOf(queued, REVIEW.id).includes("Queued — sends when the current turn finishes"), "on its card");` |
| 280 | `assert.ok( queued.includes('<div role="status" class="sr-only">Queued — sends when the current turn finishes</div>'), "and read out through the panel's always-mounted status region" );` |
| 284 | `assert.ok(queued.includes('<div role="alert" class="sr-only"></div>'), "the alert region, mounted and empty");` |
| 285 | `assert.ok( panel.includes('<div role="status" class="sr-only"></div><div role="alert" class="sr-only"></div>'), "both regions exist before anything is said in them" );` |
| 297 | `assert.ok(refusedRow.includes("Couldn&#x27;t read git status: fatal: bad object"), "the reason, on its row");` |
| 298 | `assert.ok(refusedRow.includes("text-danger"));` |
| 299 | `assert.ok( !buttonWith(refusedRow, "Plan before coding").includes("fatal: bad object"), "beside the row's buttons, not inside one — it is not part of the row's name" );` |
| 303 | `assert.ok( refused.includes('<div role="alert" class="sr-only">Couldn&#x27;t read git status: fatal: bad object</div>'), "read out through the alert region" );` |
| 311 | `assert.ok(notice.includes("Couldn&#x27;t pin the prompt: offline"), "a failed change is shown");` |
| 312 | `assert.ok(buttonWith(notice, "Dismiss").includes("h-6 w-6"), "and can be dismissed — a 24px target");` |
| 319 | `assert.ok(loading.includes("Loading prompts…"));` |
| 322 | `assert.ok(failed.includes("Couldn&#x27;t load saved prompts") && failed.includes("boom"));` |
| 323 | `assert.ok(buttonWith(failed, "Retry"), "with a retry");` |
| 326 | `assert.ok(none.includes("No saved prompts yet"));` |
| 327 | `assert.ok(none.includes("they can use variables like {project} and {branch}."));` |
| 330 | `assert.ok(noMatch.includes("No prompts match “deploy”"));` |
| 335 | `assert.ok(noProject.includes("No project prompts yet"));` |
| 336 | `assert.ok(buttonWith(noProject, "Project").includes('aria-pressed="true"'));` |
| 341 | `assert.ok( refreshFailed.includes('<span class="min-w-0 flex-1 break-words">Couldn&#x27;t refresh saved prompts: offline</span>'), "the line says what the panel was told, word for word (list.logic's savedPromptsLoadErrorLine)" );` |
| 345 | `assert.ok(buttonWith(refreshFailed, "Retry"), "with a retry");` |
| 352 | `assert.ok(DISABLED_ATTR.test(projectOption), "Project is disabled without a project");` |
| 353 | `assert.ok(projectOption.includes('title="Open a project to list its prompts"'), "and says why");` |
| 361 | `assert.ok(buttonWith(sheetCard, "Insert").includes("h-10"), "taller Insert");` |
| 362 | `assert.ok(buttonWith(sheetCard, "Send").includes("h-10"), "taller Send");` |
| 363 | `assert.ok(buttonWith(cardOf(sheet, PLAN.id), "Plan before coding").includes("py-3"), "taller rows");` |
| 364 | `assert.ok(buttonWith(sheetCard, "Pin").includes("h-10 w-10"), "a 40px star");` |
| 366 | `assert.ok(!sheetCard.includes("More actions"), "no actions menu in the sheet");` |
| 367 | `assert.ok(sheetCard.includes('aria-label="Actions for Review current changes"'));` |
| 369 | `assert.ok(buttonWith(sheetCard, label).includes("min-h-10"), ′${label} inline, 40px tall′);` |
| 371 | `assert.ok(buttonWith(sheetCard, "Delete").includes("text-danger"), "Delete reads as destructive");` |
| 373 | `assert.ok(!card.includes('aria-label="Actions for'), "docked: behind the … menu, not inline");` |
| 380 | `assert.ok(confirmingCard.includes('aria-label="Delete prompt"'), "the card asks before deleting");` |
| 381 | `assert.ok(confirmingCard.includes("Delete this prompt?"));` |
| 382 | `assert.ok(buttonWith(confirmingCard, "Delete").includes("bg-danger-600"), "a destructive Delete");` |
| 383 | `assert.ok(buttonWith(confirmingCard, "Cancel"), "and a way back");` |
| 384 | `assert.ok(!confirmingCard.includes(">Insert"), "in place of Insert / Send while it asks");` |
| 385 | `assert.ok(!confirmingCard.includes('aria-label="Actions for'), "and of the actions: one decision at a time");` |
| 386 | `assert.ok(!cardOf(confirming, PLAN.id).includes("Delete this prompt?"), "only on that card");` |
| 410 | `assert.ok(projectCard.includes("Project</span>"), "a project prompt's scope chip");` |
| 411 | `assert.ok(!projectCard.includes("Context:"), "no Context line without git variables");` |
| 413 | `assert.ok(pin.includes('aria-pressed="false"') && pin.includes('title="Pin"'), "an unpinned star offers Pin");` |
| 417 | `assert.ok(bodyOnly.includes("Explore {project} and propose a plan"), "no description: the body previews");` |
| 438 | `assert.ok(fresh.includes(">New prompt</span>"), "titled New prompt");` |
| 440 | `assert.ok(fresh.includes(′>${label}′), ′the ${label} field′);` |
| 442 | `assert.ok(fresh.includes('role="switch"') && fresh.includes('aria-label="Pinned"'), "pinned is a switch");` |
| 443 | `assert.ok(fresh.includes("<textarea") && fresh.includes('rows="12"') && fresh.includes("font-mono"), "a monospace body");` |
| 444 | `assert.ok(fresh.includes("resize-y"), "resizable");` |
| 445 | `assert.ok(fresh.includes("0/120") && fresh.includes("0/300") && fresh.includes("0/32,000"), "live counts");` |
| 446 | `assert.ok(!DISABLED_ATTR.test(buttonWith(fresh, "This project")), "This project with a project open");` |
| 447 | `assert.ok(buttonWith(fresh, "Global").includes('aria-pressed="true"'), "global by default");` |
| 450 | `assert.ok(chip.includes(′title="${spec.description.replace(/'/g, "&#x27;")}"′), ′{${spec.name}} explains itself′);` |
| 452 | `assert.ok(DISABLED_ATTR.test(buttonWith(fresh, "Save")), "nothing to save yet");` |
| 453 | `assert.ok(buttonWith(fresh, "Save").includes('title="Give the prompt a title and a body"'));` |
| 454 | `assert.ok(!fresh.includes("Uses:"), "no Uses line without variables");` |
| 455 | `assert.ok(fresh.includes("<kbd"), "the save shortcut");` |
| 473 | `assert.ok(filled.includes(">Edit prompt</span>"), "titled Edit prompt");` |
| 474 | `assert.ok(filled.includes("Uses: {branch}, {diff}"), "the variables the body uses, once each, known ones only");` |
| 475 | `assert.ok(!DISABLED_ATTR.test(buttonWith(filled, "Save")), "a valid draft saves");` |
| 476 | `assert.ok(filled.includes('aria-checked="true"'), "pinned");` |
| 484 | `assert.ok(over.includes("121/120") && over.includes("At most 120 characters."), "over the limit, said at once");` |
| 485 | `assert.ok(DISABLED_ATTR.test(buttonWith(over, "Save")));` |
| 488 | `assert.ok(DISABLED_ATTR.test(buttonWith(noProjectForm, "This project")), "no project: global only");` |
| 496 | `assert.ok(buttonWith(saving, "Saving…").includes("animate-spin"), "saving shows");` |
| 497 | `assert.ok(DISABLED_ATTR.test(buttonWith(saving, "Saving…")), "no second save meanwhile");` |
| 498 | `assert.ok(!DISABLED_ATTR.test(buttonWith(saving, "Cancel")), "but the editor may be closed: the save still lands");` |
| 499 | `assert.ok(saving.includes("Saved prompts are full") && saving.includes('role="alert"'), "a refusal, inline");` |

## Production callers and support audit before edits

- `SavedPromptsPanel` calls delivery, list selection, editor bridge and focus planning; `SavedPromptEditor` calls the saver and editor logic; these real owners remain.
- `hooks.ts` consumes `promptsForProject`, load keys and optimistic pin presentation. `context.ts` consumes agent/model labels and path names.
- `menuFocusIndex` has only an in-file production call plus deleted tests: remove its export, retain behavior.
- `sanitizeSavedPrompt` has only in-file production calls plus direct tests: route validation assertions through `applySavedPromptEvent` and remove export.
- `foldSearchText`, `searchWords`, `matchesSearch`, `belongsToProject`, `promptsInScope`, `compareByTitle`, `compareByRecency` have only in-file production callers; retain implementation and remove unneeded exports when their direct probes go.
- `formatTagsText`, `parseTagsText`, `duplicateTitle` are private editor implementation helpers after rewrites: remove exports; `normalizeDescription` remains used by form.
- `variables.ts` has unused shared formatter re-exports and dead `localDate`/`localTime` wrappers. Remove them after repository-wide reference checks; keep `projectNamesFromPath` for context.ts.
- Deleted checks own all inline fixtures, HTML extraction helpers and noop action maps: deleting those files removes their support completely.

## Completion and validation

Implemented, not audit-only. Every disposition above was applied. The 117 original named test executions became 60 UI cases plus 5 relocated API cases: 36 KEEP, 29 REWRITE, 52 DELETE (the sign-out/connection source-grep family contains two executions). The render check's 124 assertion statements and its inline mockups/helpers were also deleted. Test code is net negative by 1,158 lines including the 89-line API owner file.

Completed production/support cleanup:

- Made in-file-only helpers private: `sanitizeSavedPrompt`, `belongsToProject`, `promptsInScope`, `foldSearchText`, `searchWords`, `matchesSearch`, `compareByTitle`, `compareByRecency`, `parseTagsText`, `formatTagsText`, `duplicateTitle`, `menuFocusIndex` and `CHAT_CHANGED_REASON`.
- Removed test-only exports of `SavedPromptItemProps`, `SavedPromptEditorFormProps` and `SavedPromptsPanelViewProps`; component implementations remain production callers of those types.
- Removed dead `localDate`/`localTime` wrappers and ten unused formatter/constant re-exports from the UI variable adapter. `projectNamesFromPath` remains consumed by `context.ts`.
- Removed inline static-markup mockups, HTML selectors, action noops, fake daemon create/update/increment behavior, fake clock, generated resolver text and unused imports. Fixed external replies now test store application rather than a second implementation of daemon mutations.
- No production behavior changed and no live daemon/browser/server was started.

Validation:

- Before editing, command U passed all **117 tests**. No retained baseline regression failed.
- After pruning, command U passed all **60 tests**. An intermediate missing-import edit in the list test was caught and corrected before the final run.
- Command A passed all **5 tests**, at the shared resolver owner. The required clock fixture was corrected after an intermediate typecheck caught it.
- `pnpm --filter @orquester/ui typecheck` ran and reported only concurrent out-of-scope agent-chat test imports/signatures being changed by other agents (composer/history/retention and related files); there were no saved-prompts or prompt-variable-values diagnostics. Root was informed and owns final repository gates after integration.
- `git diff --check -- packages/ui/src/lib/saved-prompts packages/ui/src/components/right-rail/saved-prompts packages/api/src/prompt-variable-values.test.ts docs/test-cleanup/ui_general_saved_prompts.md` passed. Reviewed the complete scoped diff, including all production changes.

The five API owner cases are the rewritten original UI git-variable cases in the ledger: detached/no-repository branch, changed-file status and rename paths, missing repository and 500-file bound, truncated patch plus untracked data, and untracked-only/clean/missing-repository diff. Duplicate main-branch, clean-files and patch-only baselines remain solely in API `renders every variable`.

Remaining integration work is root-owned full repository typecheck/test/build, commit, remote merge audit and push. There is no scope-specific blocked cleanup.
