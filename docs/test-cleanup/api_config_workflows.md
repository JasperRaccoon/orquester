# Completed cleanup: API workflow/config scope

Disposition recorded before edits. Scope is every named case in the 19 assigned files; parameterized input families remain one named case. Baseline and final validation are appended below.

For each retained or rewritten case, the numbered contract record below supplies all six bars, together with its concrete named failure/expected behavior and case-specific note. Unit failure modes are listed before the cases. No retained test uses a source grep or visual regression.

## packages/api/src/cliproxy-launch-models.test.ts

Failure modes: wrong keyed aliases, unkeyed availability, credential state or catalogue fallback hides/selects an unlaunchable model.
Non-test callers: apps/daemon/src/mcp/agents.ts and packages/ui/src/components/topbar/NewTabMenu.tsx.
1. Independent contract: README model-proxy launch promise and proxy launch public API.
2. Observable failure: wrong keyed aliases, unkeyed availability, credential state or catalogue fallback hides/selects an unlaunchable model; each case below selects a distinct input/state or API operation.
3. Oracle: literal input/output examples, hand-specified state/identity sets, protocol bytes, UTC calendar instants or mathematical divisors; never results computed by the tested function. Rewrites remove declared-value/AST/copy oracles.
4. Stable seam: proxyLaunchModels.
5. Refactor tolerance: tests observe returned/persisted data or externally specified errors, with no collaborator order, internal AST shape, layout coordinates or rendered prose snapshots after pruning.
6. Lowest owner: this package owns the shared contract used by the listed callers. Higher-layer service/UI suites cover transport/orchestration; they do not replace these specific grammar, migration, state-matrix and request-validation examples. Deleted duplicate/helper cases name their remaining stronger owner below.
Risk: low for pruning presentation/declaration checks; preserved storage/security/runtime contracts remain tested.
Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/cliproxy-launch-models.test.ts`.

- **DELETE** `with an empty catalogue every curated pick is offered` — Expected IDs copied from imported production catalogue; tests detect declaration wiring, not independently fixed availability. Router/xAI/filter behavior cases retain real availability transitions.
- **KEEP** `a keyed router provider adds its alias (or name) with its label; an unkeyed one adds nothing` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **REWRITE** `xAI models appear while linked or expired, labelled as the Grok account` — Use literal launch IDs and caller-visible availability/provider-label results; remove declaration-derived catalogue equality. Distinguish credential states and live-catalogue filtering from unmatched-catalogue fallback.
- **REWRITE** `a non-empty catalogue filters the picks to what the proxy serves, falling back to all picks when none match` — Use literal launch IDs and caller-visible availability/provider-label results; remove declaration-derived catalogue equality. Distinguish credential states and live-catalogue filtering from unmatched-catalogue fallback.
- **DELETE** `a null status yields the curated list` — Expected IDs copied from imported production catalogue; tests detect declaration wiring, not independently fixed availability. Router/xAI/filter behavior cases retain real availability transitions.

## packages/api/src/prompt-variables.test.ts

Failure modes: wrong timezone/context text, failed git read sent as partial prompt, cancellation ignored, inserted text expanded.
Non-test callers: daemon workflow agent nodes and UI saved-prompts/variables.ts.
1. Independent contract: saved-prompt variable public API and workflows design §3.3 two-pass escaping.
2. Observable failure: wrong timezone/context text, failed git read sent as partial prompt, cancellation ignored, inserted text expanded; each case below selects a distinct input/state or API operation.
3. Oracle: literal input/output examples, hand-specified state/identity sets, protocol bytes, UTC calendar instants or mathematical divisors; never results computed by the tested function. Rewrites remove declared-value/AST/copy oracles.
4. Stable seam: resolvePromptVariables.
5. Refactor tolerance: tests observe returned/persisted data or externally specified errors, with no collaborator order, internal AST shape, layout coordinates or rendered prose snapshots after pruning.
6. Lowest owner: this package owns the shared contract used by the listed callers. Higher-layer service/UI suites cover transport/orchestration; they do not replace these specific grammar, migration, state-matrix and request-validation examples. Deleted duplicate/helper cases name their remaining stronger owner below.
Risk: low for pruning presentation/declaration checks; preserved storage/security/runtime contracts remain tested.
Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/prompt-variables.test.ts`.

- **KEEP** `renders every variable` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `dates and times follow the given zone` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **REWRITE** `without a zone, the runtime's local clock (the browser's)` — Observe only resolver text/timezone fallback or structured failure category and affected variables. Remove direct formatting-helper duplicates and prose-exact error assertions.
- **DELETE** `the clock is read at most once, and only when used` — Clock/read counts and duplicated constants are private call shape; standalone normalization/error helper tests use an internal seam. Retained resolver output, failure-category, cancellation and timezone cases protect the user contract; unique value edge cases are relocated from UI tests by the UI owner.
- **DELETE** `reads only what the body uses, the diff with the default cap` — Clock/read counts and duplicated constants are private call shape; standalone normalization/error helper tests use an internal seam. Retained resolver output, failure-category, cancellation and timezone cases protect the user contract; unique value edge cases are relocated from UI tests by the UI owner.
- **REWRITE** `names the failed read and the variables that needed it` — Observe only resolver text/timezone fallback or structured failure category and affected variables. Remove direct formatting-helper duplicates and prose-exact error assertions.
- **KEEP** `an aborted resolve is cancelled` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `text inserted by a workflow expression and escaped stays literal` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `no project reads as no repository` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **DELETE** `normalizePromptProjectPath` — Clock/read counts and duplicated constants are private call shape; standalone normalization/error helper tests use an internal seam. Retained resolver output, failure-category, cancellation and timezone cases protect the user contract; unique value edge cases are relocated from UI tests by the UI owner.
- **DELETE** `promptVariableErrorText` — Clock/read counts and duplicated constants are private call shape; standalone normalization/error helper tests use an internal seam. Retained resolver output, failure-category, cancellation and timezone cases protect the user contract; unique value edge cases are relocated from UI tests by the UI owner.

## packages/api/src/saved-prompts.test.ts

Failure modes: unknown/code braces changed, missing/empty variables confused, saved literal prompt re-expanded.
Non-test callers: UI saved prompt rendering and daemon workflow agent prompts.
1. Independent contract: saved-prompt public template language and history save-as-prompt contract.
2. Observable failure: unknown/code braces changed, missing/empty variables confused, saved literal prompt re-expanded; each case below selects a distinct input/state or API operation.
3. Oracle: literal input/output examples, hand-specified state/identity sets, protocol bytes, UTC calendar instants or mathematical divisors; never results computed by the tested function. Rewrites remove declared-value/AST/copy oracles.
4. Stable seam: renderPromptTemplate/promptVariablesUsed/escapePromptVariables.
5. Refactor tolerance: tests observe returned/persisted data or externally specified errors, with no collaborator order, internal AST shape, layout coordinates or rendered prose snapshots after pruning.
6. Lowest owner: this package owns the shared contract used by the listed callers. Higher-layer service/UI suites cover transport/orchestration; they do not replace these specific grammar, migration, state-matrix and request-validation examples. Deleted duplicate/helper cases name their remaining stronger owner below.
Risk: low for pruning presentation/declaration checks; preserved storage/security/runtime contracts remain tested.
Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/saved-prompts.test.ts`.

- **DELETE** `knows exactly the listed names` — Tautology: loops the declaration used to build the predicate. Rendering tests independently cover known, unknown and escaped names.
- **KEEP** `lists the known variables a body uses, once each, in first-use order` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `renders known variables and leaves everything else as written` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `renders an escaped known name as its literal text` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `substitutes a value verbatim, even one that looks like a variable` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `substitutes an empty value` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `keeps a sent prompt literal through a save and a render` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `leaves text without known variables alone` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.

## packages/api/src/workflows/block-types.test.ts

Non-test callers: workflow editor, patcher and MCP catalog still use the production owner. No production behavior is removed. Risk: visual/template wording changes are intentionally unconstrained; workflow patch/validation suites retain data correctness. Validation: focused API workflow suite.

- **DELETE** `covers every type, and every example config is valid` — Catalogue/category/example/default inventories and help-copy search mirror declarations; name formatting is a presentation choice. Patch add/create tests protect valid usable defaults and collision-free names at the caller seam.
- **DELETE** `every default config is valid, and a fresh copy each time` — Catalogue/category/example/default inventories and help-copy search mirror declarations; name formatting is a presentation choice. Patch add/create tests protect valid usable defaults and collision-free names at the caller seam.
- **DELETE** `names by type, then numbers` — Catalogue/category/example/default inventories and help-copy search mirror declarations; name formatting is a presentation choice. Patch add/create tests protect valid usable defaults and collision-free names at the caller seam.
- **DELETE** `names every root and filter` — Catalogue/category/example/default inventories and help-copy search mirror declarations; name formatting is a presentation choice. Patch add/create tests protect valid usable defaults and collision-free names at the caller seam.

## packages/api/src/workflows/expressions.test.ts

Failure modes: wrong grammar/coercion, missing-data warnings, unsafe property/secret traversal, escaped text expansion, bad renames.
Non-test callers: daemon workflow node implementations, validator, patcher.
1. Independent contract: workflows design §3.3 expression grammar/security.
2. Observable failure: wrong grammar/coercion, missing-data warnings, unsafe property/secret traversal, escaped text expansion, bad renames; each case below selects a distinct input/state or API operation.
3. Oracle: literal input/output examples, hand-specified state/identity sets, protocol bytes, UTC calendar instants or mathematical divisors; never results computed by the tested function. Rewrites remove declared-value/AST/copy oracles.
4. Stable seam: renderTemplate/renderTemplateValue, evaluateExpression missing-state API, rewriteNodeReferences.
5. Refactor tolerance: tests observe returned/persisted data or externally specified errors, with no collaborator order, internal AST shape, layout coordinates or rendered prose snapshots after pruning.
6. Lowest owner: this package owns the shared contract used by the listed callers. Higher-layer service/UI suites cover transport/orchestration; they do not replace these specific grammar, migration, state-matrix and request-validation examples. Deleted duplicate/helper cases name their remaining stronger owner below.
Risk: low for pruning presentation/declaration checks; preserved storage/security/runtime contracts remain tested.
Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/workflows/expressions.test.ts`.

- **DELETE** `splits text and expressions with offsets` — Private AST segment/offset shape and typed-impossible input probing; reference-list convenience helpers have no production caller. Rendering, validation and rename outcomes cover meaningful contracts.
- **REWRITE** `parses dot, index and quoted keys, and filters with arguments` — Keep grammar/security behavior through rendered text or raw values and warning presence; remove internal AST expectations and weak typeof probes. Inputs retain quoted braces, literals, invalid syntax, adversarial lengths and many expressions.
- **REWRITE** `accepts literal kinds in filter arguments` — Keep grammar/security behavior through rendered text or raw values and warning presence; remove internal AST expectations and weak typeof probes. Inputs retain quoted braces, literals, invalid syntax, adversarial lengths and many expressions.
- **REWRITE** `reports syntax errors and keeps the broken text literal` — Keep grammar/security behavior through rendered text or raw values and warning presence; remove internal AST expectations and weak typeof probes. Inputs retain quoted braces, literals, invalid syntax, adversarial lengths and many expressions.
- **REWRITE** `an unclosed {{ is an error and the rest is text` — Keep grammar/security behavior through rendered text or raw values and warning presence; remove internal AST expectations and weak typeof probes. Inputs retain quoted braces, literals, invalid syntax, adversarial lengths and many expressions.
- **REWRITE** `finds the closing braces past quoted }}` — Keep grammar/security behavior through rendered text or raw values and warning presence; remove internal AST expectations and weak typeof probes. Inputs retain quoted braces, literals, invalid syntax, adversarial lengths and many expressions.
- **KEEP** `\\{{ is a literal` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **REWRITE** `caps path depth` — Use independent literal security limits (32 path segments, 1 MiB text), not imported production constants.
- **REWRITE** `does not parse a template over the length cap` — Use independent literal security limits (32 path segments, 1 MiB text), not imported production constants.
- **REWRITE** `handles many expressions and hostile input without blowing up` — Keep grammar/security behavior through rendered text or raw values and warning presence; remove internal AST expectations and weak typeof probes. Inputs retain quoted braces, literals, invalid syntax, adversarial lengths and many expressions.
- **DELETE** `a non-string template is empty` — Private AST segment/offset shape and typed-impossible input probing; reference-list convenience helpers have no production caller. Rendering, validation and rename outcomes cover meaningful contracts.
- **KEEP** `inserts strings as they are and anything else as pretty JSON` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `reads node status and error` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `a missing path renders empty and warns with the expression` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `default() fills a missing, null or empty value and silences the warning` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `filters` — §3.3 defines each filter independently. Through `renderTemplate`, `[1, 2, 3] | json` must render the indented JSON array, `first`/`last` return `1`/`3`, `length` returns `3`, `"x" | upper` returns `X`, chained upper/lower returns `app`, default plus trim returns `pad`, and `lines(2)` keeps `Looks good\nline two` while `lines(0)` returns empty. Object compact/JSON results use the independent standard JSON encoder; an object's length is its own-key count. Wrong coercion, filter order, list selection or line slicing changes a user's rendered workflow input. This rendering owner combines parsed paths and filter operations; syntax-only and missing-value cases cannot detect these successful transformations. File-level bars 1–6 apply; no AST or helper-call shape is asserted.
- **KEEP** `filter misuse warns and renders empty` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `a cyclic value warns rather than throwing` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `broken expressions stay as written and warn` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `escapeValue applies to inserted values only` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `never reads inherited properties` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `does not traverse non-plain objects` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `own JSON keys that look dangerous are refused at parse time` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `secrets must name exactly one secret` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `a context missing a root reads as missing` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `a single expression yields the raw value` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `anything else renders as text` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `reports missing separately from the value` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **DELETE** `lists paths, node names and secret names` — Private AST segment/offset shape and typed-impossible input probing; reference-list convenience helpers have no production caller. Rendering, validation and rename outcomes cover meaningful contracts.
- **KEEP** `hasTemplate: workflow expressions only` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `rewrites dot and bracket references, preserving the rest` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `leaves escapes, broken expressions and unrelated text alone` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `round-trips several references in one template` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.

## packages/api/src/workflows/graph.test.ts

Failure modes: premature/duplicate execution, dead branch execution, stalled joins, ignored error routing, wrong dependency reachability.
Non-test callers: apps/daemon/src/workflows/engine.ts; validator and UI partial execution.
1. Independent contract: workflows design §3.4 DAG/dead-path execution.
2. Observable failure: premature/duplicate execution, dead branch execution, stalled joins, ignored error routing, wrong dependency reachability; each case below selects a distinct input/state or API operation.
3. Oracle: literal input/output examples, hand-specified state/identity sets, protocol bytes, UTC calendar instants or mathematical divisors; never results computed by the tested function. Rewrites remove declared-value/AST/copy oracles.
4. Stable seam: computeReadiness and shared graph traversal API.
5. Refactor tolerance: tests observe returned/persisted data or externally specified errors, with no collaborator order, internal AST shape, layout coordinates or rendered prose snapshots after pruning.
6. Lowest owner: this package owns the shared contract used by the listed callers. Higher-layer service/UI suites cover transport/orchestration; they do not replace these specific grammar, migration, state-matrix and request-validation examples. Deleted duplicate/helper cases name their remaining stronger owner below.
Risk: low for pruning presentation/declaration checks; preserved storage/security/runtime contracts remain tested.
Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/workflows/graph.test.ts`.

- **DELETE** `per type` — Output/input inventories and label copy duplicate graph declarations. validate.test.ts edge-integrity and switch-handle cases plus patch connect and readiness cases protect actual routing/rejection behavior.
- **DELETE** `labels` — Output/input inventories and label copy duplicate graph declarations. validate.test.ts edge-integrity and switch-handle cases plus patch connect and readiness cases protect actual routing/rejection behavior.
- **DELETE** `inputs` — Output/input inventories and label copy duplicate graph declarations. validate.test.ts edge-integrity and switch-handle cases plus patch connect and readiness cases protect actual routing/rejection behavior.
- **KEEP** `topological order, ties by definition order, notes excluded` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `upstream / downstream / reachable` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `cycles` — §3.4 requires a DAG. For edges `a→b→c→a` plus disconnected `d→d`, `topologicalOrder` must return null and `findCycles` must identify exactly the node sets `{a,b,c}` and `{d}`; the authored acyclic control must report none. Missing a disconnected self-loop, accepting a multi-node cycle, or marking a DAG cyclic would misidentify executable/invalid workflow blocks. Literal graph connectivity supplies the oracle independently of the traversal algorithm. The validator owns rejection issue codes; this lowest graph owner owns the exact participating node sets used by validation. File-level bars 1–6 apply and component ordering is normalized, so traversal refactors survive.
- **KEEP** `ignores edges to missing nodes and to notes` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **DELETE** `findCycles copes with a long chain without recursion` — 5000-node internal algorithm stress bypasses the public 200-node validator hard limit. Validator limit regression protects hostile requests before cycle analysis; retained cycles checks protect accepted DAG inputs.
- **KEEP** `a straight line: the next block is ready once the previous finished` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `triggers that did not fire are skipped: their paths die` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `IF: the untaken branch is skipped, transitively` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `diamond: the join waits for both branches` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `diamond after an IF: the join runs on the one live branch` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `error routes: a failure takes the error edge; success kills it` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `one stop fed by several error edges runs on whichever fired` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `merge in first mode starts on the first live input` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `switch: the taken case lives; a switch that matched nothing kills every output` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `a cancelled source kills its edges; an unconnected block is skipped` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `finished, running and waiting blocks are neither ready nor skipped; triggers never are` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `a partial run: a failed block routed on error keeps the success path dead` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.

## packages/api/src/workflows/layout.test.ts

Non-test callers: workflow editor, patcher and MCP catalog still use the production owner. No production behavior is removed. Risk: visual/template wording changes are intentionally unconstrained; workflow patch/validation suites retain data correctness. Validation: focused API workflow suite.

- **DELETE** `lays a chain out left to right, from the origin, on the grid` — Geometry, grid, spacing, coordinate and box-overlap change detectors. No required visual-regression contract. Patch tests retain explicit caller-provided position persistence; layout remains used by the editor and patcher.
- **DELETE** `branches stack vertically without overlapping; notes are left alone` — Geometry, grid, spacing, coordinate and box-overlap change detectors. No required visual-regression contract. Patch tests retain explicit caller-provided position persistence; layout remains used by the editor and patcher.
- **DELETE** `a selection keeps its corner` — Geometry, grid, spacing, coordinate and box-overlap change detectors. No required visual-regression contract. Patch tests retain explicit caller-provided position persistence; layout remains used by the editor and patcher.
- **DELETE** `failure branches go below the success path, which stays on one row (the Jira fixer)` — Geometry, grid, spacing, coordinate and box-overlap change detectors. No required visual-regression contract. Patch tests retain explicit caller-provided position persistence; layout remains used by the editor and patcher.
- **DELETE** `a failure branch keeps its own chain, below the block it leaves` — Geometry, grid, spacing, coordinate and box-overlap change detectors. No required visual-regression contract. Patch tests retain explicit caller-provided position persistence; layout remains used by the editor and patcher.
- **DELETE** `a block a success edge also reaches stays on the success path` — Geometry, grid, spacing, coordinate and box-overlap change detectors. No required visual-regression contract. Patch tests retain explicit caller-provided position persistence; layout remains used by the editor and patcher.
- **DELETE** `columns leave room for a branch label; a many-output switch is laid out taller` — Geometry, grid, spacing, coordinate and box-overlap change detectors. No required visual-regression contract. Patch tests retain explicit caller-provided position persistence; layout remains used by the editor and patcher.
- **DELETE** `an empty or notes-only graph yields nothing` — Geometry, grid, spacing, coordinate and box-overlap change detectors. No required visual-regression contract. Patch tests retain explicit caller-provided position persistence; layout remains used by the editor and patcher.
- **DELETE** `everything new: a full layout, notes stacked below` — Geometry, grid, spacing, coordinate and box-overlap change detectors. No required visual-regression contract. Patch tests retain explicit caller-provided position persistence; layout remains used by the editor and patcher.
- **DELETE** `a new node goes right of its placed input, avoiding existing boxes` — Geometry, grid, spacing, coordinate and box-overlap change detectors. No required visual-regression contract. Patch tests retain explicit caller-provided position persistence; layout remains used by the editor and patcher.
- **DELETE** `a chain of new nodes extends to the right; a node with only an output goes left of it` — Geometry, grid, spacing, coordinate and box-overlap change detectors. No required visual-regression contract. Patch tests retain explicit caller-provided position persistence; layout remains used by the editor and patcher.
- **DELETE** `an unconnected new node goes below everything` — Geometry, grid, spacing, coordinate and box-overlap change detectors. No required visual-regression contract. Patch tests retain explicit caller-provided position persistence; layout remains used by the editor and patcher.

## packages/api/src/workflows/outline.test.ts

Failure modes: missing or duplicated actionable steps, join links to wrong node, disconnected nodes falsely marked reachable.
Non-test callers: packages/ui/src/lib/workflows/outline-display.ts and canvas-fit.ts.
1. Independent contract: workflows design §7.4 actionable Steps navigation.
2. Observable failure: missing or duplicated actionable steps, join links to wrong node, disconnected nodes falsely marked reachable; each case below selects a distinct input/state or API operation.
3. Oracle: literal input/output examples, hand-specified state/identity sets, protocol bytes, UTC calendar instants or mathematical divisors; never results computed by the tested function. Rewrites remove declared-value/AST/copy oracles.
4. Stable seam: buildStepOutline.
5. Refactor tolerance: tests observe returned/persisted data or externally specified errors, with no collaborator order, internal AST shape, layout coordinates or rendered prose snapshots after pruning.
6. Lowest owner: this package owns the shared contract used by the listed callers. Higher-layer service/UI suites cover transport/orchestration; they do not replace these specific grammar, migration, state-matrix and request-validation examples. Deleted duplicate/helper cases name their remaining stronger owner below.
Risk: low for pruning presentation/declaration checks; preserved storage/security/runtime contracts remain tested.
Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/workflows/outline.test.ts`.

- **DELETE** `a straight line stays flat` — Serialized indentation/row snapshots couple tests to presentation layout. Semantic node membership, join navigation and unreachable-state contracts survive in the three rewritten cases.
- **DELETE** `an IF indents both branches, true first` — Serialized indentation/row snapshots couple tests to presentation layout. Semantic node membership, join navigation and unreachable-state contracts survive in the three rewritten cases.
- **DELETE** `an error route indents the success path too` — Serialized indentation/row snapshots couple tests to presentation layout. Semantic node membership, join navigation and unreachable-state contracts survive in the three rewritten cases.
- **DELETE** `a lone non-success output is indented` — Serialized indentation/row snapshots couple tests to presentation layout. Semantic node membership, join navigation and unreachable-state contracts survive in the three rewritten cases.
- **REWRITE** `a diamond: the join appears once, after both branches, at the fork's level` — Keep Steps navigation data only: diamond includes each actionable node once and both branch links target its join; disconnected nodes retain unreachable state and notes are excluded; a cyclic draft still includes every distinct node without duplicate actionable steps. Remove indentation, coordinates and row-count snapshots.
- **DELETE** `parallel branches from one block join after them` — Serialized indentation/row snapshots couple tests to presentation layout. Semantic node membership, join navigation and unreachable-state contracts survive in the three rewritten cases.
- **DELETE** `the Jira template: one failure stop fed from three blocks` — Serialized indentation/row snapshots couple tests to presentation layout. Semantic node membership, join navigation and unreachable-state contracts survive in the three rewritten cases.
- **DELETE** `two triggers feeding one block` — Serialized indentation/row snapshots couple tests to presentation layout. Semantic node membership, join navigation and unreachable-state contracts survive in the three rewritten cases.
- **DELETE** `the same target on two handles` — Serialized indentation/row snapshots couple tests to presentation layout. Semantic node membership, join navigation and unreachable-state contracts survive in the three rewritten cases.
- **DELETE** `switch cases in order` — Serialized indentation/row snapshots couple tests to presentation layout. Semantic node membership, join navigation and unreachable-state contracts survive in the three rewritten cases.
- **REWRITE** `unreachable blocks come last, flat; notes are not steps` — Keep Steps navigation data only: diamond includes each actionable node once and both branch links target its join; disconnected nodes retain unreachable state and notes are excluded; a cyclic draft still includes every distinct node without duplicate actionable steps. Remove indentation, coordinates and row-count snapshots.
- **REWRITE** `a cycle does not loop forever` — Keep Steps navigation data only: diamond includes each actionable node once and both branch links target its join; disconnected nodes retain unreachable state and notes are excluded; a cyclic draft still includes every distinct node without duplicate actionable steps. Remove indentation, coordinates and row-count snapshots.
- **DELETE** `no trigger: everything is unreachable` — Serialized indentation/row snapshots couple tests to presentation layout. Semantic node membership, join navigation and unreachable-state contracts survive in the three rewritten cases.

## packages/api/src/workflows/patch.test.ts

Failure modes: partial commit on error, corrupted IDs/references/config, dropped pins/edges, incorrect request defaults.
Non-test callers: daemon workflows/service.ts, MCP error attribution, UI editor-store.ts.
1. Independent contract: workflows design §8.2 atomic patch public request operations.
2. Observable failure: partial commit on error, corrupted IDs/references/config, dropped pins/edges, incorrect request defaults; each case below selects a distinct input/state or API operation.
3. Oracle: literal input/output examples, hand-specified state/identity sets, protocol bytes, UTC calendar instants or mathematical divisors; never results computed by the tested function. Rewrites remove declared-value/AST/copy oracles.
4. Stable seam: applyWorkflowPatch/createWorkflowFromRequest.
5. Refactor tolerance: tests observe returned/persisted data or externally specified errors, with no collaborator order, internal AST shape, layout coordinates or rendered prose snapshots after pruning.
6. Lowest owner: this package owns the shared contract used by the listed callers. Higher-layer service/UI suites cover transport/orchestration; they do not replace these specific grammar, migration, state-matrix and request-validation examples. Deleted duplicate/helper cases name their remaining stronger owner below.
Risk: low for pruning presentation/declaration checks; preserved storage/security/runtime contracts remain tested.
Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/workflows/patch.test.ts`.

- **KEEP** `never mutates its input and stamps updatedAt` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **REWRITE** `add_node mints id and name, fills defaults, merges config, places it` — Keep assigned identity, defaults, schema-valid records and edge resolution; remove computed layout-coordinate and overlap assertions.
- **KEEP** `add_node keeps a given id, name and position; refuses duplicates, bad names, bad types, bad configs` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `update_node merges config one level deep; null clears` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `update_node refuses id/type changes, unknown fields and invalid configs` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `update_node with a name renames and rewrites references, including its own` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `rename_node rewrites every template reference and session.fromNode` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `remove_node drops its edges and pin` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `connect checks handles, inputs, self-loops and duplicates` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `disconnect by id or by endpoints` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `settings, project, enabled, name, pins` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `is atomic: the failing op is named and nothing applies` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **REWRITE** `mints ids and names, applies defaults, lays out and resolves edge refs by name` — Keep assigned identity, defaults, schema-valid records and edge resolution; remove computed layout-coordinate and overlap assertions.
- **REWRITE** `autoLayout lays out every node; otherwise given positions stay` — Keep caller-supplied position as persisted request data; remove auto-layout coordinates and relative geometry assertions.
- **KEEP** `names the failing node or edge` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **DELETE** `uses a fixed Date as the clock too` — Clock injection representation compatibility is test plumbing; create/patch timestamp behavior is already protected using production-style function clocks.

## packages/api/src/workflows/rules.test.ts

Failure modes: wrong branch on numeric/presence/string predicates, loss of warnings, unsafe regex or unbounded input.
Non-test callers: daemon workflow flow node shares operand/evaluation core with async rule API.
1. Independent contract: workflows design §4 IF/Switch operator semantics and regex security limits.
2. Observable failure: wrong branch on numeric/presence/string predicates, loss of warnings, unsafe regex or unbounded input; each case below selects a distinct input/state or API operation.
3. Oracle: literal input/output examples, hand-specified state/identity sets, protocol bytes, UTC calendar instants or mathematical divisors; never results computed by the tested function. Rewrites remove declared-value/AST/copy oracles.
4. Stable seam: evaluateRule/evaluateRules/evaluateSwitch.
5. Refactor tolerance: tests observe returned/persisted data or externally specified errors, with no collaborator order, internal AST shape, layout coordinates or rendered prose snapshots after pruning.
6. Lowest owner: this package owns the shared contract used by the listed callers. Higher-layer service/UI suites cover transport/orchestration; they do not replace these specific grammar, migration, state-matrix and request-validation examples. Deleted duplicate/helper cases name their remaining stronger owner below.
Risk: low for pruning presentation/declaration checks; preserved storage/security/runtime contracts remain tested.
Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/workflows/rules.test.ts`.

- **KEEP** `equals / notEquals compare loosely across representations` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `contains searches lists by element and text by substring` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **REWRITE** `numeric comparisons parse numbers and warn on non-numbers` — Exercise numeric coercion and regex safety through rule results/warnings, removing direct private-helper probes. Use literal 100*1024 input cap and literal hostile pattern limits.
- **KEEP** `presence operators treat a missing value as an answer, without a warning` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `isTrue / isFalse` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `matches with plain and /literal/flags patterns` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **REWRITE** `matches refuses catastrophic patterns` — Exercise numeric coercion and regex safety through rule results/warnings, removing direct private-helper probes. Use literal 100*1024 input cap and literal hostile pattern limits.
- **REWRITE** `matches only searches the first 100 KB` — Exercise numeric coercion and regex safety through rule results/warnings, removing direct private-helper probes. Use literal 100*1024 input cap and literal hostile pattern limits.
- **KEEP** `combines with all / any` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `collects every rule's warnings` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `takes the first matching case` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `falls back to default, or to nothing` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.

## packages/api/src/workflows/schedule.test.ts

Failure modes: wrong cron, invalid high-frequency schedules accepted, DST duplicate/missed fires, uneven promised interval.
Non-test callers: daemon schedule routes/scheduler and UI TriggerSettings.
1. Independent contract: workflows design §4/§6.1 cron authority, minimum minute, IANA timezone scheduling.
2. Observable failure: wrong cron, invalid high-frequency schedules accepted, DST duplicate/missed fires, uneven promised interval; each case below selects a distinct input/state or API operation.
3. Oracle: literal input/output examples, hand-specified state/identity sets, protocol bytes, UTC calendar instants or mathematical divisors; never results computed by the tested function. Rewrites remove declared-value/AST/copy oracles.
4. Stable seam: presetToCron/validateCron/nextRuns/scheduleIntervalProblem.
5. Refactor tolerance: tests observe returned/persisted data or externally specified errors, with no collaborator order, internal AST shape, layout coordinates or rendered prose snapshots after pruning.
6. Lowest owner: this package owns the shared contract used by the listed callers. Higher-layer service/UI suites cover transport/orchestration; they do not replace these specific grammar, migration, state-matrix and request-validation examples. Deleted duplicate/helper cases name their remaining stronger owner below.
Risk: low for pruning presentation/declaration checks; preserved storage/security/runtime contracts remain tested.
Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/workflows/schedule.test.ts`.

- **KEEP** `derives 5-field crons` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **DELETE** `every derived cron is valid` — Cross-calling production helpers is not an independent cron oracle; English summary copy is presentation; direct timezone wrapper is duplicated by validateCron and nextRuns contracts.
- **DELETE** `speaks the preset` — Cross-calling production helpers is not an independent cron oracle; English summary copy is presentation; direct timezone wrapper is duplicated by validateCron and nextRuns contracts.
- **DELETE** `falls back to the cron when the preset is cron or no longer matches` — Cross-calling production helpers is not an independent cron oracle; English summary copy is presentation; direct timezone wrapper is duplicated by validateCron and nextRuns contracts.
- **KEEP** `accepts 5 fields, nicknames and 6 fields with a fixed second` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `refuses the rest with a reason` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **DELETE** `time zones` — Cross-calling production helpers is not an independent cron oracle; English summary copy is presentation; direct timezone wrapper is duplicated by validateCron and nextRuns contracts.
- **KEEP** `every 15 minutes, from a given instant, in UTC ISO` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `a daily time follows the zone's wall clock across the spring DST change` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `a time that does not exist on the spring-forward day still fires once that day` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `a time repeated on the fall-back day fires once` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `other zones` — §6.1 and the workflow IANA timezone field require local wall-clock scheduling. A 09:00 daily New York schedule must fire at `2026-10-31T13:00:00.000Z` and, after fall-back, `2026-11-01T14:00:00.000Z`; Monday 09:00 in Kolkata must fire at `2026-09-28T03:30:00.000Z`. Fixed calendar instants independently catch using UTC/system time, retaining the pre-DST offset, or rounding a half-hour offset. `nextRuns` is the shared scheduler/preview owner; repeated-hour hourly cases and Berlin spring-gap cases do not cover these daily/half-hour inputs. File-level bars 1–6 apply; no cron-library call shape or presentation wording is asserted.
- **KEEP** `an invalid cron or zone yields nothing` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `America/New_York fall-back: a sub-daily cron fires in the repeated hour too` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `a daily cron in the repeated hour still fires once` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `Europe/Berlin fall-back: the repeated 02:00–03:00 fires twice for an hourly cron` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `spring-forward never repeats or reorders instants` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **REWRITE** `accepts exactly the divisors of 60 (minutes) and 24 (hours)` — Retain independent mathematical divisor oracle for evenly recurring minute/hour intervals, remove exported option-array declaration inventories.

## packages/api/src/workflows/templates.test.ts

Failure modes: templates auto-run or fail validation, ADF descriptions lost, wrong authenticated Jira endpoint, wrong ticket transitioned.
Non-test callers: UI new workflow creation; generated code run by workflow code runner.
1. Independent contract: workflows design §7.1 starter workflows and Jira Cloud request/data contract.
2. Observable failure: templates auto-run or fail validation, ADF descriptions lost, wrong authenticated Jira endpoint, wrong ticket transitioned; each case below selects a distinct input/state or API operation.
3. Oracle: literal input/output examples, hand-specified state/identity sets, protocol bytes, UTC calendar instants or mathematical divisors; never results computed by the tested function. Rewrites remove declared-value/AST/copy oracles.
4. Stable seam: buildTemplate create requests and actual generated code entrypoints.
5. Refactor tolerance: tests observe returned/persisted data or externally specified errors, with no collaborator order, internal AST shape, layout coordinates or rendered prose snapshots after pruning.
6. Lowest owner: this package owns the shared contract used by the listed callers. Higher-layer service/UI suites cover transport/orchestration; they do not replace these specific grammar, migration, state-matrix and request-validation examples. Deleted duplicate/helper cases name their remaining stronger owner below.
Risk: low for pruning presentation/declaration checks; preserved storage/security/runtime contracts remain tested.
Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/workflows/templates.test.ts`.

- **REWRITE** `every template builds, is disabled, and validates with zero errors` — Keep usable disabled create requests and Jira HTTP/data behavior. Remove template-ID inventory, exact log/error prose and a stop mock that merely returns its argument; use a stop sentinel to prove empty results stop execution.
- **DELETE** `the Jira fixer's shape` — Graph/node/provider template inventories and an impossible typed template ID constrain sample implementation. Retained build validity/disabled state and execution of Jira code guard real usable-template behavior.
- **DELETE** `the release reviewer watches v* tags with Codex` — Graph/node/provider template inventories and an impossible typed template ID constrain sample implementation. Retained build validity/disabled state and execution of Jira code guard real usable-template behavior.
- **DELETE** `an unknown template throws` — Graph/node/provider template inventories and an impossible typed template ID constrain sample implementation. Retained build validity/disabled state and execution of Jira code guard real usable-template behavior.
- **REWRITE** `FetchTickets searches, flattens descriptions, and stops when there is nothing` — Keep usable disabled create requests and Jira HTTP/data behavior. Remove template-ID inventory, exact log/error prose and a stop mock that merely returns its argument; use a stop sentinel to prove empty results stop execution.
- **REWRITE** `MarkDone transitions what the agent fixed` — Keep usable disabled create requests and Jira HTTP/data behavior. Remove template-ID inventory, exact log/error prose and a stop mock that merely returns its argument; use a stop sentinel to prove empty results stop execution.

## packages/api/src/workflows/triggers-text.test.ts

Failure modes: SSH/HTTP/Bitbucket path identities display wrong repository.
Non-test callers: daemon workflows/summary.ts and trigger cards.
1. Independent contract: clone URL repository identity public helper.
2. Observable failure: SSH/HTTP/Bitbucket path identities display wrong repository; each case below selects a distinct input/state or API operation.
3. Oracle: literal input/output examples, hand-specified state/identity sets, protocol bytes, UTC calendar instants or mathematical divisors; never results computed by the tested function. Rewrites remove declared-value/AST/copy oracles.
4. Stable seam: repoDisplayName.
5. Refactor tolerance: tests observe returned/persisted data or externally specified errors, with no collaborator order, internal AST shape, layout coordinates or rendered prose snapshots after pruning.
6. Lowest owner: this package owns the shared contract used by the listed callers. Higher-layer service/UI suites cover transport/orchestration; they do not replace these specific grammar, migration, state-matrix and request-validation examples. Deleted duplicate/helper cases name their remaining stronger owner below.
Risk: low for pruning presentation/declaration checks; preserved storage/security/runtime contracts remain tested.
Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/workflows/triggers-text.test.ts`.

- **DELETE** `manual and non-triggers` — Exact English trigger/date summary copy is not a protocol; schedule execution and zone correctness remain protected by schedule.test.ts.
- **DELETE** `schedule, with the next run` — Exact English trigger/date summary copy is not a protocol; schedule execution and zone correctness remain protected by schedule.test.ts.
- **DELETE** `git events` — Exact English trigger/date summary copy is not a protocol; schedule execution and zone correctness remain protected by schedule.test.ts.
- **KEEP** `reads owner/repo from any clone URL` — Protects clone URL normalization for HTTPS, scp SSH, explicit-port SSH, and Bitbucket context paths: callers must receive repository identity a/b, team/repo, proj/repo or PROJ/repo rather than host/transport syntax.
- **DELETE** `today, this week, later` — Exact English trigger/date summary copy is not a protocol; schedule execution and zone correctness remain protected by schedule.test.ts.

## packages/api/src/workflows/validate.test.ts

Failure modes: bad graphs/data execute, invalid references or credentials overlooked, security warnings lost, resource limits bypassed.
Non-test callers: daemon workflow service/routes and UI editor-store.
1. Independent contract: workflows design §3.3/§3.4/§4/§8 limits and structured validation public contract.
2. Observable failure: bad graphs/data execute, invalid references or credentials overlooked, security warnings lost, resource limits bypassed; each case below selects a distinct input/state or API operation.
3. Oracle: literal input/output examples, hand-specified state/identity sets, protocol bytes, UTC calendar instants or mathematical divisors; never results computed by the tested function. Rewrites remove declared-value/AST/copy oracles.
4. Stable seam: validateWorkflow.
5. Refactor tolerance: tests observe returned/persisted data or externally specified errors, with no collaborator order, internal AST shape, layout coordinates or rendered prose snapshots after pruning.
6. Lowest owner: this package owns the shared contract used by the listed callers. Higher-layer service/UI suites cover transport/orchestration; they do not replace these specific grammar, migration, state-matrix and request-validation examples. Deleted duplicate/helper cases name their remaining stronger owner below.
Risk: low for pruning presentation/declaration checks; preserved storage/security/runtime contracts remain tested.
Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/workflows/validate.test.ts`.

- **KEEP** `has no problems and parses` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **DELETE** `every emitted code is declared` — Declaration inventory compares codes to the code list; private UTF-8 helper unit assertion is below the stable validation owner. Retain real error-code and size-limit outcomes.
- **KEEP** `rejects a non-object and non-JSON` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `maps record issues to fields, and still checks the blocks` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **REWRITE** `a broken block reports its own problem with its id; the others are still checked` — Keep schema/validation code, severity, field and node/edge identities; remove presentation prose expectations. Split reference failures where needed so category/state proves each distinct invalid reference.
- **KEEP** `unknown block types and bad edges are schema problems` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `nodes and edges must be lists` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **REWRITE** `counts blocks, connections, name length and size` — Replace imported-limit-derived oversized inputs with independent documented numeric bounds; exercise UTF-8 definition-size rejection at the public validator instead of private byte helper.
- **DELETE** `utf8ByteLength` — Declaration inventory compares codes to the code list; private UTF-8 helper unit assertion is below the stable validation owner. Retain real error-code and size-limit outcomes.
- **KEEP** `unique ids and names, valid names` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **REWRITE** `each integrity rule` — Keep schema/validation code, severity, field and node/edge identities; remove presentation prose expectations. Split reference failures where needed so category/state proves each distinct invalid reference.
- **KEEP** `switch handles follow its cases` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **REWRITE** `cycles` — Keep schema/validation code, severity, field and node/edge identities; remove presentation prose expectations. Split reference failures where needed so category/state proves each distinct invalid reference.
- **KEEP** `syntax errors in every template field` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `code source is JavaScript, not a template` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **REWRITE** `unknown blocks are errors; blocks that do not run first are warnings` — Keep schema/validation code, severity, field and node/edge identities; remove presentation prose expectations. Split reference failures where needed so category/state proves each distinct invalid reference.
- **REWRITE** `{{ }} in a shell script is refused with the fix` — Keep schema/validation code, severity, field and node/edge identities; remove presentation prose expectations. Split reference failures where needed so category/state proves each distinct invalid reference.
- **REWRITE** `secrets: unknown names, whole-store reads, and prompts` — Keep schema/validation code, severity, field and node/edge identities; remove presentation prose expectations. Split reference failures where needed so category/state proves each distinct invalid reference.
- **KEEP** `untrusted git text in a prompt warns` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `agent: empty prompt, saved prompt, chain length, max minutes` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **REWRITE** `agent: the chain is checked against the host catalogue when one is given` — Keep schema/validation code, severity, field and node/edge identities; remove presentation prose expectations. Split reference failures where needed so category/state proves each distinct invalid reference.
- **REWRITE** `agent: continue must name an upstream agent` — Keep schema/validation code, severity, field and node/edge identities; remove presentation prose expectations. Split reference failures where needed so category/state proves each distinct invalid reference.
- **REWRITE** `code: size, default export, memory, timeout` — Replace imported-limit-derived oversized inputs with independent documented numeric bounds; exercise UTF-8 definition-size rejection at the public validator instead of private byte helper.
- **KEEP** `http: url and timeout` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **REWRITE** `wait, block timeouts` — Replace imported-limit-derived oversized inputs with independent documented numeric bounds; exercise UTF-8 definition-size rejection at the public validator instead of private byte helper.
- **KEEP** `schedule: cron and zone, preset drift` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `schedule: an 'every N' preset must divide the hour/day — an error on a save, a warning on a stored definition` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `git: releases are GitHub only` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `sub-workflow: unset, self, unknown` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `no trigger is information only` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `blocks no trigger reaches never run` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **REWRITE** `pinned data` — Replace imported-limit-derived oversized inputs with independent documented numeric bounds; exercise UTF-8 definition-size rejection at the public validator instead of private byte helper.
- **KEEP** `the result carries schema defaults` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.

## packages/config/src/agent-accounts.test.ts

Failure modes: lost defaults/metadata, unsupported account kind accepted, account home relocated.
Non-test callers: daemon agent-accounts service and managed launch homes.
1. Independent contract: README managed accounts and persisted config/path compatibility.
2. Observable failure: lost defaults/metadata, unsupported account kind accepted, account home relocated; each case below selects a distinct input/state or API operation.
3. Oracle: literal input/output examples, hand-specified state/identity sets, protocol bytes, UTC calendar instants or mathematical divisors; never results computed by the tested function. Rewrites remove declared-value/AST/copy oracles.
4. Stable seam: parseAgentAccounts/createDefaultAgentAccounts/path helpers.
5. Refactor tolerance: tests observe returned/persisted data or externally specified errors, with no collaborator order, internal AST shape, layout coordinates or rendered prose snapshots after pruning.
6. Lowest owner: this package owns the shared contract used by the listed callers. Higher-layer service/UI suites cover transport/orchestration; they do not replace these specific grammar, migration, state-matrix and request-validation examples. Deleted duplicate/helper cases name their remaining stronger owner below.
Risk: low for pruning presentation/declaration checks; preserved storage/security/runtime contracts remain tested.
Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/config/src/agent-accounts.test.ts`.

- **KEEP** `createDefaultAgentAccounts is empty with null defaults` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `parseAgentAccounts fills defaults and coerces missing fields` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `parseAgentAccounts rejects an unknown agent` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **REWRITE** `path helpers compose under the daemon dir` — Assert complete independent persisted paths under /base/daemon; suffix-only assertions passed if files accidentally moved outside the daemon directory.

## packages/config/src/index.test.ts

Failure modes: account/workflow owner lost, restart markers lost, older/malformed optional fields destroy readable records, sandbox escape.
Non-test callers: daemon session persistence, agent-host thread store and filesystem operations.
1. Independent contract: AGENTS filesystem containment and tolerant persisted session/thread compatibility; goals design §5.5/§5.7.
2. Observable failure: account/workflow owner lost, restart markers lost, older/malformed optional fields destroy readable records, sandbox escape; each case below selects a distinct input/state or API operation.
3. Oracle: literal input/output examples, hand-specified state/identity sets, protocol bytes, UTC calendar instants or mathematical divisors; never results computed by the tested function. Rewrites remove declared-value/AST/copy oracles.
4. Stable seam: parseSessionsConfig/parseAgentThreadHead/isValidName/assertInsideFsRoot.
5. Refactor tolerance: tests observe returned/persisted data or externally specified errors, with no collaborator order, internal AST shape, layout coordinates or rendered prose snapshots after pruning.
6. Lowest owner: this package owns the shared contract used by the listed callers. Higher-layer service/UI suites cover transport/orchestration; they do not replace these specific grammar, migration, state-matrix and request-validation examples. Deleted duplicate/helper cases name their remaining stronger owner below.
Risk: low for pruning presentation/declaration checks; preserved storage/security/runtime contracts remain tested.
Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/config/src/index.test.ts`.

- **KEEP** `isValidName rejects traversal and empties` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `sessionRecordSchema round-trips accountId so reattach keeps the account pin` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `sessionRecordSchema keeps a workflow owner and drops a malformed one, never the record` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `assertInsideFsRoot allows in-root paths and rejects escapes` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `a head carrying the goal-resume marker round-trips it` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `a head written before goals — no marker — still parses, and says no` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `a malformed goal-resume marker is dropped, never the whole head` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `a head carrying the goal-hold marker round-trips it, beside the other two` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `a head without the goal-hold marker says no, and writes none back` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `a malformed goal-hold marker is dropped, never the whole head` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `a stamped continuation marker round-trips beside both goal marks — through JSON, as meta.json holds it` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `a malformed continuation stamp reads as unstamped — an older host's marker — never an unreadable head` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.

## packages/config/src/saved-prompts-config.test.ts

Failure modes: prompts or unknown fields lost on rollback/rewrite, duplicate records destroyed, prototype pollution, unknown version overwritten.
Non-test callers: apps/daemon/src/saved-prompts.ts.
1. Independent contract: AGENTS tolerant persisted JSON preservation and saved-prompts storage contract.
2. Observable failure: prompts or unknown fields lost on rollback/rewrite, duplicate records destroyed, prototype pollution, unknown version overwritten; each case below selects a distinct input/state or API operation.
3. Oracle: literal input/output examples, hand-specified state/identity sets, protocol bytes, UTC calendar instants or mathematical divisors; never results computed by the tested function. Rewrites remove declared-value/AST/copy oracles.
4. Stable seam: parseSavedPromptsConfig/savedPromptsPath.
5. Refactor tolerance: tests observe returned/persisted data or externally specified errors, with no collaborator order, internal AST shape, layout coordinates or rendered prose snapshots after pruning.
6. Lowest owner: this package owns the shared contract used by the listed callers. Higher-layer service/UI suites cover transport/orchestration; they do not replace these specific grammar, migration, state-matrix and request-validation examples. Deleted duplicate/helper cases name their remaining stronger owner below.
Risk: low for pruning presentation/declaration checks; preserved storage/security/runtime contracts remain tested.
Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/config/src/saved-prompts-config.test.ts`.

- **KEEP** `savedPromptsPath lives beside the other daemon-owned indexes` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `a well-formed library round-trips unchanged` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `bad entries are set aside one by one, verbatim; the rest of the library loads` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `a repeated id keeps its first record; the others are set aside, not dropped` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `unknown top-level keys are kept, exactly as found` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `optional fields default, limits are NOT re-applied, and unknown fields pass through` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `the outer shape still throws — an unknown version included — so the file is not rewritten` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.

## packages/config/src/usage-prefs-migrate.test.ts

Failure modes: legacy opt-out lost, absent new agent incorrectly disabled, master switch ignored.
Non-test callers: daemon usage.ts and UI usage overview.
1. Independent contract: usage persisted config migration and public usageAgentEnabled contract.
2. Observable failure: legacy opt-out lost, absent new agent incorrectly disabled, master switch ignored; each case below selects a distinct input/state or API operation.
3. Oracle: literal input/output examples, hand-specified state/identity sets, protocol bytes, UTC calendar instants or mathematical divisors; never results computed by the tested function. Rewrites remove declared-value/AST/copy oracles.
4. Stable seam: usagePrefsSchema/usageAgentEnabled.
5. Refactor tolerance: tests observe returned/persisted data or externally specified errors, with no collaborator order, internal AST shape, layout coordinates or rendered prose snapshots after pruning.
6. Lowest owner: this package owns the shared contract used by the listed callers. Higher-layer service/UI suites cover transport/orchestration; they do not replace these specific grammar, migration, state-matrix and request-validation examples. Deleted duplicate/helper cases name their remaining stronger owner below.
Risk: low for pruning presentation/declaration checks; preserved storage/security/runtime contracts remain tested.
Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/config/src/usage-prefs-migrate.test.ts`.

- **KEEP** `legacy claude/codex booleans migrate into agents record` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `new agents record passes through` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.
- **KEEP** `disabled master switch overrides per-agent` — Protects the concrete input/output contract named here; failures change data, validation, or persisted state consumed by the owner.

## packages/config/src/usage-prefs.check.ts

Failure modes: legacy app fails loading or wrong default/chip selection persists.
Non-test callers: desktop app config loading and daemon usage preferences.
1. Independent contract: usage persisted config/default/migration contract.
2. Observable failure: legacy app fails loading or wrong default/chip selection persists; each case below selects a distinct input/state or API operation.
3. Oracle: literal input/output examples, hand-specified state/identity sets, protocol bytes, UTC calendar instants or mathematical divisors; never results computed by the tested function. Rewrites remove declared-value/AST/copy oracles.
4. Stable seam: parseAppConfig/createDefaultAppConfig/usagePrefsSchema.
5. Refactor tolerance: tests observe returned/persisted data or externally specified errors, with no collaborator order, internal AST shape, layout coordinates or rendered prose snapshots after pruning.
6. Lowest owner: this package owns the shared contract used by the listed callers. Higher-layer service/UI suites cover transport/orchestration; they do not replace these specific grammar, migration, state-matrix and request-validation examples. Deleted duplicate/helper cases name their remaining stronger owner below.
Risk: low for pruning presentation/declaration checks; preserved storage/security/runtime contracts remain tested.
Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/config/src/usage-prefs-migrate.test.ts`.

- **REWRITE** `default usage preferences; partial chip default; legacy app without usage; invalid chip rejection; Grok chip acceptance` — Move existing config/default/migration assertions into usage-prefs-migrate.test.ts so the repository test gate executes them; remove orphan standalone check and console-only success marker.

## Planned dead support/seams

- Remove unreferenced `referencedNodeNames` / `referencedSecretNames` convenience wrappers; validator uses `templateReferences` directly. Make layout sizing/failure-side helpers and prompt path/error helpers private after tests stop importing them. Rule numeric/regex helper visibility will be reduced after public-rule rewrites. Shared workflow fixtures remain used by retained tests.
- No package scripts, persisted formats or runtime behavior change. UI owner relocates unique prompt value contracts to a separate API test file and records those cases in its own report.

## Validation

- Baseline: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test $(cat /tmp/orquester-test-cleanup/api_config_workflows.txt | rg '\.test\.ts$')` — 222 tests passed, 0 failures.
- After cleanup: same assigned test list filtered to existing `.test.ts` paths — 169 tests passed, 0 failures.
- Follow-up expression/validation/rule tests after helper visibility cleanup: 73 passed, 0 failures. A rewritten escaped-literal probe initially used an existing input path and therefore did not invoke its default; corrected its fixture to `input.nope`, then passed. Baseline had no product failures.
- `pnpm --filter @orquester/config typecheck` — passed.
- `pnpm --filter @orquester/api typecheck` — passed after the parallel UI owner added the required clock to its relocated prompt-value fixture.
- Assigned diff and production-seam diff inspected; scoped `git diff --check` passed. Root owns repository-wide gates and final integration.

Follow-up disposition before final edits: `expressions.test.ts` / `\\{{ is a literal` is REWRITE: retain literal rendered text and escaped-expression non-expansion; discard parser segment count/shape. Same expression-language six-bar record applies. Repository-wide references show `WORKFLOW_PROBLEM_CODES` and its inferred type have no production consumer; delete that test-only declaration inventory. Expression/rule caps and layout height/separation/grid constants have only same-module production consumers; make those private, retaining the width/rank exports consumed by Steps editing.

Completed support removal: two unused expression-reference wrappers and the unused workflow problem-code inventory/type removed. Private-only exports removed from prompt normalization/error helpers, layout sizing/failure-side helpers and unused layout constants, numeric/regex rule helpers/caps, expression caps, and UTF-8 byte helper. No fixtures were orphaned; shared workflow `testing.ts` remains used. Usage standalone check removed after moving its five assertions into the scripted migration suite.
