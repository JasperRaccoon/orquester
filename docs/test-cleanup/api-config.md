# API/config cleanup audit and completed-work record

Pre-edit inventory: 172 named tests in 16 files. Parameterized cases are recorded under their original named case. Read root AGENTS.md, README.md, package commands, every scoped test, each production owner and repository references before these dispositions. Existing earlier audit files describe prior cleanups and were not used as a verdict for the current suite.

No test/spec/check/assertion entry points exist in packages/registry, apps/web or apps/desktop. Their scripts are TypeScript/build gates, unchanged. API src/agent-chat belongs to another agent.

The six numbered bars below apply to each KEEP/REWRITE row in its file section; each row identifies a specific failure and independent oracle. DELETE rows identify the stronger surviving coverage or explain why there is no legitimate contract.

## `packages/api/src/prompt-variable-values.test.ts`

Unit failure modes considered first: wrong repository state; omitted rename source/untracked files; unbounded inserted status.
Non-test callers: UI saved-prompt source and daemon workflow agent prompts.
1. Independent contract: public saved-prompt git-variable format, including rename/untracked data and caps.
2. Observable failure: the concrete incorrect result/rejection/data loss in each row below affects these callers.
3. Oracle: literal fixture data/results, fixed storage paths, protocol fields or known UTC/calendar instants; no expected result is generated with the function under test. The schedule divisor oracle is mathematical arithmetic, independent of the implementation’s permitted-value tables.
4. Stable seam: resolvePromptVariables; fixture providers supply external data, not the asserted result.
5. Refactor tolerance: retained assertions concern returned data, accepted/rejected requests, persisted values or externally consumed diagnostics; private IDs/order, prose and geometry are pruned as listed.
6. Lowest owner: this package owns this shared contract. Retained cases exercise distinct grammar, input, state or protocol branches not replaced by transport/UI tests; duplicate helper/layer cases are deleted explicitly below.
Risk: low for pruning duplicate/presentation assertions; persistence, security, branching and migration behavior remain covered. Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/prompt-variable-values.test.ts`.

- **KEEP** `{branch}: detached or no repository ` — The named behavior fails: {branch}: detached or no repository. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `{changedFiles}: one line per file, renames with both paths ` — The named behavior fails: {changedFiles}: one line per file, renames with both paths. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `{changedFiles}: not a repo, and capped ` — The named behavior fails: {changedFiles}: not a repo, and capped. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `{diff}: the patch, then the cut, then the untracked files ` — The named behavior fails: {diff}: the patch, then the cut, then the untracked files. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `{diff}: untracked alone, clean, and not a repo ` — The named behavior fails: {diff}: untracked alone, clean, and not a repo. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.

## `packages/api/src/prompt-variables.test.ts`

Unit failure modes considered first: wrong context or timezone inserted; failed/cancelled read sends partial prompt.
Non-test callers: UI saved-prompt source and daemon workflows/nodes/agent prompt rendering.
1. Independent contract: workflow design §5.3 resolver and timezone/failure semantics; public saved-prompt variables.
2. Observable failure: the concrete incorrect result/rejection/data loss in each row below affects these callers.
3. Oracle: literal fixture data/results, fixed storage paths, protocol fields or known UTC/calendar instants; no expected result is generated with the function under test. The schedule divisor oracle is mathematical arithmetic, independent of the implementation’s permitted-value tables.
4. Stable seam: resolvePromptVariables; fixture providers supply external data, not the asserted result.
5. Refactor tolerance: retained assertions concern returned data, accepted/rejected requests, persisted values or externally consumed diagnostics; private IDs/order, prose and geometry are pruned as listed.
6. Lowest owner: this package owns this shared contract. Retained cases exercise distinct grammar, input, state or protocol branches not replaced by transport/UI tests; duplicate helper/layer cases are deleted explicitly below.
Risk: low for pruning duplicate/presentation assertions; persistence, security, branching and migration behavior remain covered. Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/prompt-variables.test.ts`.

- **KEEP** `renders every variable ` — The named behavior fails: renders every variable. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `dates and times follow the given zone ` — The named behavior fails: dates and times follow the given zone. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `without a zone, the runtime's local clock (the browser's) ` — The named behavior fails: without a zone, the runtime's local clock (the browser's). Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `names the failed read and the variables that needed it ` — The named behavior fails: names the failed read and the variables that needed it. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `an aborted resolve is cancelled ` — The named behavior fails: an aborted resolve is cancelled. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **DELETE** `text inserted by a workflow expression and escaped stays literal ` — The named behavior fails: text inserted by a workflow expression and escaped stays literal. Repeats escape/render semantics already owned by saved-prompts.test.ts and expression escapeValue coverage; no resolver-specific behavior beyond those contracts.
- **KEEP** `no project reads as no repository ` — The named behavior fails: no project reads as no repository. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.

## `packages/api/src/saved-prompts.test.ts`

Unit failure modes considered first: literal prompt expanded, unknown braces modified, empty/missing values confused.
Non-test callers: UI saved-prompts/variables.ts, chat history; workflow prompt resolver.
1. Independent contract: public saved-prompt template language and history Save as prompt behavior.
2. Observable failure: the concrete incorrect result/rejection/data loss in each row below affects these callers.
3. Oracle: literal fixture data/results, fixed storage paths, protocol fields or known UTC/calendar instants; no expected result is generated with the function under test. The schedule divisor oracle is mathematical arithmetic, independent of the implementation’s permitted-value tables.
4. Stable seam: renderPromptTemplate, escapePromptVariables, promptVariablesUsed; fixture providers supply external data, not the asserted result.
5. Refactor tolerance: retained assertions concern returned data, accepted/rejected requests, persisted values or externally consumed diagnostics; private IDs/order, prose and geometry are pruned as listed.
6. Lowest owner: this package owns this shared contract. Retained cases exercise distinct grammar, input, state or protocol branches not replaced by transport/UI tests; duplicate helper/layer cases are deleted explicitly below.
Risk: low for pruning duplicate/presentation assertions; persistence, security, branching and migration behavior remain covered. Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/saved-prompts.test.ts`.

- **KEEP** `lists the known variables a body uses, once each, in first-use order ` — The named behavior fails: lists the known variables a body uses, once each, in first-use order. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `renders known variables and leaves everything else as written ` — The named behavior fails: renders known variables and leaves everything else as written. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `renders an escaped known name as its literal text ` — The named behavior fails: renders an escaped known name as its literal text. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `substitutes a value verbatim, even one that looks like a variable ` — The named behavior fails: substitutes a value verbatim, even one that looks like a variable. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `substitutes an empty value ` — The named behavior fails: substitutes an empty value. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `keeps a sent prompt literal through a save and a render ` — The named behavior fails: keeps a sent prompt literal through a save and a render. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **DELETE** `leaves text without known variables alone ` — The named behavior fails: leaves text without known variables alone. Duplicates the stronger save-and-render case, which already contains plain text, unknown names and code braces; no distinct caller failure.

## `packages/api/src/workflows/expressions.test.ts`

Unit failure modes considered first: bad grammar/data conversion or renamed reference; secret/prototype traversal; expression resource limit ignored.
Non-test callers: workflow node executors, validator, patcher, UI clipboard.
1. Independent contract: workflow design §3.3 expression grammar, safe reads and two-pass prompt escaping; public expression API limits.
2. Observable failure: the concrete incorrect result/rejection/data loss in each row below affects these callers.
3. Oracle: literal fixture data/results, fixed storage paths, protocol fields or known UTC/calendar instants; no expected result is generated with the function under test. The schedule divisor oracle is mathematical arithmetic, independent of the implementation’s permitted-value tables.
4. Stable seam: renderTemplate, renderTemplateValue, parseTemplate, hasTemplate, rewriteNodeReferences; fixture providers supply external data, not the asserted result.
5. Refactor tolerance: retained assertions concern returned data, accepted/rejected requests, persisted values or externally consumed diagnostics; private IDs/order, prose and geometry are pruned as listed.
6. Lowest owner: this package owns this shared contract. Retained cases exercise distinct grammar, input, state or protocol branches not replaced by transport/UI tests; duplicate helper/layer cases are deleted explicitly below.
Risk: low for pruning duplicate/presentation assertions; persistence, security, branching and migration behavior remain covered. Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/workflows/expressions.test.ts`.

- **KEEP** `parses dot, index and quoted keys, and filters with arguments ` — The named behavior fails: parses dot, index and quoted keys, and filters with arguments. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `accepts literal kinds in filter arguments ` — The named behavior fails: accepts literal kinds in filter arguments. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **REWRITE** `reports syntax errors and keeps the broken text literal ` — The named behavior fails: reports syntax errors and keeps the broken text literal. Retain grammar, missing-value or security failure via literal output and warning/error presence; remove diagnostic English fragments. Specific path data remains asserted where the path identifies the affected expression.
- **REWRITE** `an unclosed {{ is an error and the rest is text ` — The named behavior fails: an unclosed {{ is an error and the rest is text. Retain grammar, missing-value or security failure via literal output and warning/error presence; remove diagnostic English fragments. Specific path data remains asserted where the path identifies the affected expression.
- **KEEP** `finds the closing braces past quoted }} ` — The named behavior fails: finds the closing braces past quoted }}. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `\{{ is a literal ` — The named behavior fails: \{{ is a literal. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **REWRITE** `caps path depth ` — The named behavior fails: caps path depth. Retain grammar, missing-value or security failure via literal output and warning/error presence; remove diagnostic English fragments. Specific path data remains asserted where the path identifies the affected expression.
- **REWRITE** `does not parse a template over the length cap ` — The named behavior fails: does not parse a template over the length cap. Retain grammar, missing-value or security failure via literal output and warning/error presence; remove diagnostic English fragments. Specific path data remains asserted where the path identifies the affected expression.
- **REWRITE** `handles many expressions and hostile input without blowing up ` — The named behavior fails: handles many expressions and hostile input without blowing up. Retain grammar, missing-value or security failure via literal output and warning/error presence; remove diagnostic English fragments. Specific path data remains asserted where the path identifies the affected expression.
- **KEEP** `inserts strings as they are and anything else as pretty JSON ` — The named behavior fails: inserts strings as they are and anything else as pretty JSON. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `reads node status and error ` — The named behavior fails: reads node status and error. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **REWRITE** `a missing path renders empty and warns with the expression ` — The named behavior fails: a missing path renders empty and warns with the expression. Retain grammar, missing-value or security failure via literal output and warning/error presence; remove diagnostic English fragments. Specific path data remains asserted where the path identifies the affected expression.
- **KEEP** `default() fills a missing, null or empty value and silences the warning ` — The named behavior fails: default() fills a missing, null or empty value and silences the warning. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `filters ` — A requested filter returns wrong JSON, case, trimming, line selection, first/last item, or length. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **REWRITE** `filter misuse warns and renders empty ` — The named behavior fails: filter misuse warns and renders empty. Retain grammar, missing-value or security failure via literal output and warning/error presence; remove diagnostic English fragments. Specific path data remains asserted where the path identifies the affected expression.
- **REWRITE** `a cyclic value warns rather than throwing ` — The named behavior fails: a cyclic value warns rather than throwing. Retain grammar, missing-value or security failure via literal output and warning/error presence; remove diagnostic English fragments. Specific path data remains asserted where the path identifies the affected expression.
- **REWRITE** `broken expressions stay as written and warn ` — The named behavior fails: broken expressions stay as written and warn. Retain grammar, missing-value or security failure via literal output and warning/error presence; remove diagnostic English fragments. Specific path data remains asserted where the path identifies the affected expression.
- **KEEP** `escapeValue applies to inserted values only ` — The named behavior fails: escapeValue applies to inserted values only. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `never reads inherited properties ` — The named behavior fails: never reads inherited properties. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `does not traverse non-plain objects ` — The named behavior fails: does not traverse non-plain objects. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **REWRITE** `own JSON keys that look dangerous are refused at parse time ` — The named behavior fails: own JSON keys that look dangerous are refused at parse time. Retain grammar, missing-value or security failure via literal output and warning/error presence; remove diagnostic English fragments. Specific path data remains asserted where the path identifies the affected expression.
- **REWRITE** `secrets must name exactly one secret ` — The named behavior fails: secrets must name exactly one secret. Retain grammar, missing-value or security failure via literal output and warning/error presence; remove diagnostic English fragments. Specific path data remains asserted where the path identifies the affected expression.
- **KEEP** `a context missing a root reads as missing ` — The named behavior fails: a context missing a root reads as missing. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `a single expression yields the raw value ` — The named behavior fails: a single expression yields the raw value. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `anything else renders as text ` — The named behavior fails: anything else renders as text. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **DELETE** `reports missing separately from the value ` — The named behavior fails: reports missing separately from the value. Asserts intermediate evaluator bookkeeping after parser helper assembly; renderTemplateValue missing output and rule presence semantics catch the actual caller failure.
- **KEEP** `hasTemplate: workflow expressions only ` — Shell safety check mistakes Docker/escaped braces for expressions or misses malformed workflow expressions. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `rewrites dot and bracket references, preserving the rest ` — The named behavior fails: rewrites dot and bracket references, preserving the rest. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `leaves escapes, broken expressions and unrelated text alone ` — The named behavior fails: leaves escapes, broken expressions and unrelated text alone. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **DELETE** `round-trips several references in one template ` — The named behavior fails: round-trips several references in one template. Duplicates multiple-reference rewrite coverage in the preceding dot/bracket case and patch rename integration; round-trip adds no independently specified failure.

## `packages/api/src/workflows/graph.test.ts`

Unit failure modes considered first: wrong runnable/skipped blocks, premature joins, missing partial-run descendants or accepted cycles.
Non-test callers: daemon workflow engine; UI connection/steps/run-view; validator.
1. Independent contract: workflow design §3.4 readiness, dead-path elimination, DAG and merge semantics.
2. Observable failure: the concrete incorrect result/rejection/data loss in each row below affects these callers.
3. Oracle: literal fixture data/results, fixed storage paths, protocol fields or known UTC/calendar instants; no expected result is generated with the function under test. The schedule divisor oracle is mathematical arithmetic, independent of the implementation’s permitted-value tables.
4. Stable seam: computeReadiness, upstreamOf, downstreamOf, reachableFromTriggers, topologicalOrder; fixture providers supply external data, not the asserted result.
5. Refactor tolerance: retained assertions concern returned data, accepted/rejected requests, persisted values or externally consumed diagnostics; private IDs/order, prose and geometry are pruned as listed.
6. Lowest owner: this package owns this shared contract. Retained cases exercise distinct grammar, input, state or protocol branches not replaced by transport/UI tests; duplicate helper/layer cases are deleted explicitly below.
Risk: low for pruning duplicate/presentation assertions; persistence, security, branching and migration behavior remain covered. Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/workflows/graph.test.ts`.

- **DELETE** `topological order, ties by definition order, notes excluded ` — The named behavior fails: topological order, ties by definition order, notes excluded. Pins helper tie order and separately inventories executable nodes. Readiness/outline retained cases protect executable actions; tie order among independent blocks is not user behavior.
- **KEEP** `upstream / downstream / reachable ` — Transitive ancestors/descendants or trigger-reachable node sets omit a branch or include the start node. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **DELETE** `cycles ` — A cyclic graph is accepted, allowing a workflow that cannot progress. Duplicates DAG rejection owned by validate.test.ts cycles; SCC ordering and topological helper null are implementation-level intermediates.
- **DELETE** `ignores edges to missing nodes and to notes ` — The named behavior fails: ignores edges to missing nodes and to notes. Pins adjacency helper treatment of invalid edges; validate.test.ts each integrity rule and outline nonactionable-note behavior own accepted graph behavior.
- **KEEP** `a straight line: the next block is ready once the previous finished ` — The named behavior fails: a straight line: the next block is ready once the previous finished. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `triggers that did not fire are skipped: their paths die ` — The named behavior fails: triggers that did not fire are skipped: their paths die. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `IF: the untaken branch is skipped, transitively ` — The named behavior fails: IF: the untaken branch is skipped, transitively. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `diamond: the join waits for both branches ` — The named behavior fails: diamond: the join waits for both branches. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `diamond after an IF: the join runs on the one live branch ` — The named behavior fails: diamond after an IF: the join runs on the one live branch. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `error routes: a failure takes the error edge; success kills it ` — The named behavior fails: error routes: a failure takes the error edge; success kills it. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `one stop fed by several error edges runs on whichever fired ` — The named behavior fails: one stop fed by several error edges runs on whichever fired. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `merge in first mode starts on the first live input ` — The named behavior fails: merge in first mode starts on the first live input. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `switch: the taken case lives; a switch that matched nothing kills every output ` — The named behavior fails: switch: the taken case lives; a switch that matched nothing kills every output. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `a cancelled source kills its edges; an unconnected block is skipped ` — The named behavior fails: a cancelled source kills its edges; an unconnected block is skipped. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `finished, running and waiting blocks are neither ready nor skipped; triggers never are ` — The named behavior fails: finished, running and waiting blocks are neither ready nor skipped; triggers never are. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `a partial run: a failed block routed on error keeps the success path dead ` — The named behavior fails: a partial run: a failed block routed on error keeps the success path dead. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.

## `packages/api/src/workflows/outline.test.ts`

Unit failure modes considered first: a join displayed twice/mislinked; unreachable executable step hidden; cyclic edit hangs view.
Non-test callers: UI outline-display, canvas-fit and Steps view.
1. Independent contract: workflow design §7.4 Steps view actionable order and join references.
2. Observable failure: the concrete incorrect result/rejection/data loss in each row below affects these callers.
3. Oracle: literal fixture data/results, fixed storage paths, protocol fields or known UTC/calendar instants; no expected result is generated with the function under test. The schedule divisor oracle is mathematical arithmetic, independent of the implementation’s permitted-value tables.
4. Stable seam: buildStepOutline; fixture providers supply external data, not the asserted result.
5. Refactor tolerance: retained assertions concern returned data, accepted/rejected requests, persisted values or externally consumed diagnostics; private IDs/order, prose and geometry are pruned as listed.
6. Lowest owner: this package owns this shared contract. Retained cases exercise distinct grammar, input, state or protocol branches not replaced by transport/UI tests; duplicate helper/layer cases are deleted explicitly below.
Risk: low for pruning duplicate/presentation assertions; persistence, security, branching and migration behavior remain covered. Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/workflows/outline.test.ts`.

- **KEEP** `a diamond exposes each step once and links both branches to the join ` — The named behavior fails: a diamond exposes each step once and links both branches to the join. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `disconnected blocks are marked unreachable and notes are not actionable steps ` — The named behavior fails: disconnected blocks are marked unreachable and notes are not actionable steps. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `a cycle does not loop forever ` — The named behavior fails: a cycle does not loop forever. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.

## `packages/api/src/workflows/patch.test.ts`

Unit failure modes considered first: partial update persists; references disconnect; invalid mutation accepted; created graph cannot be addressed.
Non-test callers: daemon workflow service; UI editor operations.
1. Independent contract: workflow design §8.2 atomic patch operations and public CreateWorkflowRequest.
2. Observable failure: the concrete incorrect result/rejection/data loss in each row below affects these callers.
3. Oracle: literal fixture data/results, fixed storage paths, protocol fields or known UTC/calendar instants; no expected result is generated with the function under test. The schedule divisor oracle is mathematical arithmetic, independent of the implementation’s permitted-value tables.
4. Stable seam: applyWorkflowPatch, createWorkflowFromRequest; fixture providers supply external data, not the asserted result.
5. Refactor tolerance: retained assertions concern returned data, accepted/rejected requests, persisted values or externally consumed diagnostics; private IDs/order, prose and geometry are pruned as listed.
6. Lowest owner: this package owns this shared contract. Retained cases exercise distinct grammar, input, state or protocol branches not replaced by transport/UI tests; duplicate helper/layer cases are deleted explicitly below.
Risk: low for pruning duplicate/presentation assertions; persistence, security, branching and migration behavior remain covered. Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/workflows/patch.test.ts`.

- **KEEP** `never mutates its input and stamps updatedAt ` — The named behavior fails: never mutates its input and stamps updatedAt. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **REWRITE** `add_node mints unique ids and names, fills defaults and merges config ` — The named behavior fails: add_node mints unique ids and names, fills defaults and merges config. Keep uniqueness, config defaults and resolved connection endpoints; remove dependence on ID-generator invocation order.
- **REWRITE** `add_node keeps a given id, name and position; refuses duplicates, bad names, bad types, bad configs ` — The named behavior fails: add_node keeps a given id, name and position; refuses duplicates, bad names, bad types, bad configs. Keep caller identity and explicit invalid-request rejection; remove coordinate equality and diagnostic copy.
- **KEEP** `update_node merges config one level deep; null clears ` — The named behavior fails: update_node merges config one level deep; null clears. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **REWRITE** `update_node refuses id/type changes, unknown fields and invalid configs ` — The named behavior fails: update_node refuses id/type changes, unknown fields and invalid configs. Assert WorkflowPatchError and failing operation index instead of diagnostic copy.
- **KEEP** `update_node with a name renames and rewrites references, including its own ` — The named behavior fails: update_node with a name renames and rewrites references, including its own. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **REWRITE** `rename_node rewrites every template reference and session.fromNode ` — The named behavior fails: rename_node rewrites every template reference and session.fromNode. Keep rewritten prompt/session/URL/header data and invalid-rename rejection; remove duplicate validator round-trip and incidental node count.
- **KEEP** `remove_node drops its edges and pin ` — The named behavior fails: remove_node drops its edges and pin. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **REWRITE** `connect checks handles, inputs, self-loops and duplicates ` — The named behavior fails: connect checks handles, inputs, self-loops and duplicates. Keep source-handle data and typed/indexed rejection for each invalid operation, without English error matching.
- **REWRITE** `disconnect by id or by endpoints ` — The named behavior fails: disconnect by id or by endpoints. Assert removal by edge identity/endpoints and typed rejection; remove incidental edge count and error prose.
- **REWRITE** `settings, project, enabled, name, pins ` — Requested settings replace untouched notification fields, project/name fails to change, or cleared pin/description survives. Keep public mutation results and typed/indexed rejection; remove diagnostic wording.
- **REWRITE** `is atomic: the failing op is named and nothing applies ` — The named behavior fails: is atomic: the failing op is named and nothing applies. Keep atomic source preservation and public opIndex, removing duplicate invocation solely checking copy.
- **REWRITE** `mints ids and names, applies defaults and resolves edge refs by name ` — The named behavior fails: mints ids and names, applies defaults and resolves edge refs by name. Keep generated identity uniqueness, defaults and edge resolution; remove injected ID order and duplicate validator invocation.
- **DELETE** `create preserves caller-provided positions ` — The named behavior fails: create preserves caller-provided positions. Coordinate assertion without visual regression requirement; no execution, navigation or data contract beyond geometry is asserted.
- **KEEP** `names the failing node or edge ` — Create error lacks the offending node/edge index or admits invalid workflow metadata. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.

## `packages/api/src/workflows/rules.test.ts`

Unit failure modes considered first: wrong branch/coercion; missed rule warnings; unsafe regex searched; fallback route lost.
Non-test callers: daemon workflows/nodes condition execution.
1. Independent contract: workflow design §4 IF/Switch operators and public async rule semantics; regex resource safeguards.
2. Observable failure: the concrete incorrect result/rejection/data loss in each row below affects these callers.
3. Oracle: literal fixture data/results, fixed storage paths, protocol fields or known UTC/calendar instants; no expected result is generated with the function under test. The schedule divisor oracle is mathematical arithmetic, independent of the implementation’s permitted-value tables.
4. Stable seam: evaluateRuleAsync, evaluateRulesAsync, evaluateSwitchAsync; fixture providers supply external data, not the asserted result.
5. Refactor tolerance: retained assertions concern returned data, accepted/rejected requests, persisted values or externally consumed diagnostics; private IDs/order, prose and geometry are pruned as listed.
6. Lowest owner: this package owns this shared contract. Retained cases exercise distinct grammar, input, state or protocol branches not replaced by transport/UI tests; duplicate helper/layer cases are deleted explicitly below.
Risk: low for pruning duplicate/presentation assertions; persistence, security, branching and migration behavior remain covered. Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/workflows/rules.test.ts`.

- **REWRITE** `equals / notEquals compare loosely across representations ` — The named behavior fails: equals / notEquals compare loosely across representations. Exercise production async rule API using native RegExp as matcher; delete unused synchronous evaluator seams. Keep independently literal results/handles and warning state, not warning prose.
- **REWRITE** `contains searches lists by element and text by substring ` — The named behavior fails: contains searches lists by element and text by substring. Exercise production async rule API using native RegExp as matcher; delete unused synchronous evaluator seams. Keep independently literal results/handles and warning state, not warning prose.
- **REWRITE** `numeric comparisons parse numbers and warn on non-numbers ` — The named behavior fails: numeric comparisons parse numbers and warn on non-numbers. Exercise production async rule API using native RegExp as matcher; delete unused synchronous evaluator seams. Keep independently literal results/handles and warning state, not warning prose.
- **REWRITE** `presence operators treat a missing value as an answer, without a warning ` — The named behavior fails: presence operators treat a missing value as an answer, without a warning. Exercise production async rule API using native RegExp as matcher; delete unused synchronous evaluator seams. Keep independently literal results/handles and warning state, not warning prose.
- **REWRITE** `isTrue / isFalse ` — Boolean/string booleans choose the wrong condition route or arbitrary text becomes true. Exercise production async rule API using native RegExp as matcher; delete unused synchronous evaluator seams. Keep independently literal results/handles and warning state, not warning prose.
- **REWRITE** `matches with plain and /literal/flags patterns ` — The named behavior fails: matches with plain and /literal/flags patterns. Exercise production async rule API using native RegExp as matcher; delete unused synchronous evaluator seams. Keep independently literal results/handles and warning state, not warning prose.
- **REWRITE** `matches refuses catastrophic patterns ` — The named behavior fails: matches refuses catastrophic patterns. Exercise production async rule API using native RegExp as matcher; delete unused synchronous evaluator seams. Keep independently literal results/handles and warning state, not warning prose.
- **REWRITE** `matches only searches the first 100 KB ` — The named behavior fails: matches only searches the first 100 KB. Exercise production async rule API using native RegExp as matcher; delete unused synchronous evaluator seams. Keep independently literal results/handles and warning state, not warning prose.
- **REWRITE** `combines with all / any ` — The named behavior fails: combines with all / any. Exercise production async rule API using native RegExp as matcher; delete unused synchronous evaluator seams. Keep independently literal results/handles and warning state, not warning prose.
- **REWRITE** `collects every rule's warnings ` — The named behavior fails: collects every rule's warnings. Exercise production async rule API using native RegExp as matcher; delete unused synchronous evaluator seams. Keep independently literal results/handles and warning state, not warning prose.
- **REWRITE** `takes the first matching case ` — The named behavior fails: takes the first matching case. Exercise production async rule API using native RegExp as matcher; delete unused synchronous evaluator seams. Keep independently literal results/handles and warning state, not warning prose.
- **REWRITE** `falls back to default, or to nothing ` — The named behavior fails: falls back to default, or to nothing. Exercise production async rule API using native RegExp as matcher; delete unused synchronous evaluator seams. Keep independently literal results/handles and warning state, not warning prose.

## `packages/api/src/workflows/schedule.test.ts`

Unit failure modes considered first: workflow runs at wrong instant or twice; uneven promised interval accepted; invalid cron runs.
Non-test callers: daemon schedule trigger; UI schedule editor and validator.
1. Independent contract: workflow design §6.1 cron authority, minimum interval and zoned scheduling; public DST semantics.
2. Observable failure: the concrete incorrect result/rejection/data loss in each row below affects these callers.
3. Oracle: literal fixture data/results, fixed storage paths, protocol fields or known UTC/calendar instants; no expected result is generated with the function under test. The schedule divisor oracle is mathematical arithmetic, independent of the implementation’s permitted-value tables.
4. Stable seam: presetToCron, validateCron, nextRuns, nextScheduleRun, scheduleIntervalProblem; fixture providers supply external data, not the asserted result.
5. Refactor tolerance: retained assertions concern returned data, accepted/rejected requests, persisted values or externally consumed diagnostics; private IDs/order, prose and geometry are pruned as listed.
6. Lowest owner: this package owns this shared contract. Retained cases exercise distinct grammar, input, state or protocol branches not replaced by transport/UI tests; duplicate helper/layer cases are deleted explicitly below.
Risk: low for pruning duplicate/presentation assertions; persistence, security, branching and migration behavior remain covered. Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/workflows/schedule.test.ts`.

- **KEEP** `derives 5-field crons ` — The named behavior fails: derives 5-field crons. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `accepts 5 fields, nicknames and 6 fields with a fixed second ` — The named behavior fails: accepts 5 fields, nicknames and 6 fields with a fixed second. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **REWRITE** `refuses the rest with a reason ` — The named behavior fails: refuses the rest with a reason. Keep invalid cron/timezone matrix and nonempty rejection reason; discard exact English diagnostic fragments.
- **KEEP** `every 15 minutes, from a given instant, in UTC ISO ` — The named behavior fails: every 15 minutes, from a given instant, in UTC ISO. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `a daily time follows the zone's wall clock across the spring DST change ` — The named behavior fails: a daily time follows the zone's wall clock across the spring DST change. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `a time that does not exist on the spring-forward day still fires once that day ` — The named behavior fails: a time that does not exist on the spring-forward day still fires once that day. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `a time repeated on the fall-back day fires once ` — The named behavior fails: a time repeated on the fall-back day fires once. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `other zones ` — New York DST or Kolkata half-hour offset schedules the wrong UTC instant. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `an invalid cron or zone yields nothing ` — The named behavior fails: an invalid cron or zone yields nothing. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `America/New_York fall-back: a sub-daily cron fires in the repeated hour too ` — The named behavior fails: America/New_York fall-back: a sub-daily cron fires in the repeated hour too. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `a daily cron in the repeated hour still fires once ` — The named behavior fails: a daily cron in the repeated hour still fires once. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `Europe/Berlin fall-back: the repeated 02:00–03:00 fires twice for an hourly cron ` — The named behavior fails: Europe/Berlin fall-back: the repeated 02:00–03:00 fires twice for an hourly cron. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `spring-forward never repeats or reorders instants ` — The named behavior fails: spring-forward never repeats or reorders instants. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `accepts exactly the divisors of 60 (minutes) and 24 (hours) ` — The named behavior fails: accepts exactly the divisors of 60 (minutes) and 24 (hours). Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.

## `packages/api/src/workflows/templates.test.ts`

Unit failure modes considered first: starter cannot be enabled/configured; Jira ticket data omitted; wrong transition posted.
Non-test callers: workflow rail creation and code-block executor.
1. Independent contract: workflow design §7.1 three starter templates and Jira workflow behavior; Jira HTTP request protocol.
2. Observable failure: the concrete incorrect result/rejection/data loss in each row below affects these callers.
3. Oracle: literal fixture data/results, fixed storage paths, protocol fields or known UTC/calendar instants; no expected result is generated with the function under test. The schedule divisor oracle is mathematical arithmetic, independent of the implementation’s permitted-value tables.
4. Stable seam: buildTemplate and actual emitted code module default export; fixture providers supply external data, not the asserted result.
5. Refactor tolerance: retained assertions concern returned data, accepted/rejected requests, persisted values or externally consumed diagnostics; private IDs/order, prose and geometry are pruned as listed.
6. Lowest owner: this package owns this shared contract. Retained cases exercise distinct grammar, input, state or protocol branches not replaced by transport/UI tests; duplicate helper/layer cases are deleted explicitly below.
Risk: low for pruning duplicate/presentation assertions; persistence, security, branching and migration behavior remain covered. Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/workflows/templates.test.ts`.

- **REWRITE** `every template builds, is disabled, and validates with zero errors ` — The named behavior fails: every template builds, is disabled, and validates with zero errors. Use the three independently required starter IDs rather than looping the production declaration, which can silently shrink; retain disabled/project/timezone/validity contract.
- **KEEP** `FetchTickets searches, flattens descriptions, and stops when there is nothing ` — The named behavior fails: FetchTickets searches, flattens descriptions, and stops when there is nothing. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **REWRITE** `MarkDone transitions what the agent fixed ` — The named behavior fails: MarkDone transitions what the agent fixed. Retain emitted Jira request and moved/failed/skipped records; remove exact invalid-reply error wording.

## `packages/api/src/workflows/triggers-text.test.ts`

Unit failure modes considered first: wrong repository identity displayed for supported clone syntax.
Non-test callers: workflow trigger summaries and daemon workflow summary.
1. Independent contract: public repository display-name parser for HTTPS, SSH, SCP and Bitbucket clone URLs.
2. Observable failure: the concrete incorrect result/rejection/data loss in each row below affects these callers.
3. Oracle: literal fixture data/results, fixed storage paths, protocol fields or known UTC/calendar instants; no expected result is generated with the function under test. The schedule divisor oracle is mathematical arithmetic, independent of the implementation’s permitted-value tables.
4. Stable seam: repoDisplayName; fixture providers supply external data, not the asserted result.
5. Refactor tolerance: retained assertions concern returned data, accepted/rejected requests, persisted values or externally consumed diagnostics; private IDs/order, prose and geometry are pruned as listed.
6. Lowest owner: this package owns this shared contract. Retained cases exercise distinct grammar, input, state or protocol branches not replaced by transport/UI tests; duplicate helper/layer cases are deleted explicitly below.
Risk: low for pruning duplicate/presentation assertions; persistence, security, branching and migration behavior remain covered. Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/workflows/triggers-text.test.ts`.

- **KEEP** `reads owner/repo from any clone URL ` — The named behavior fails: reads owner/repo from any clone URL. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.

## `packages/api/src/workflows/validate.test.ts`

Unit failure modes considered first: invalid workflow enabled or good workflow blocked; field diagnostics lost; unsafe shell/secrets accepted.
Non-test callers: daemon write/enable paths, MCP validation and UI editor.
1. Independent contract: workflow design §§3.3/3.4/4/7.2 and public WorkflowProblem codes; persisted config/security limits.
2. Observable failure: the concrete incorrect result/rejection/data loss in each row below affects these callers.
3. Oracle: literal fixture data/results, fixed storage paths, protocol fields or known UTC/calendar instants; no expected result is generated with the function under test. The schedule divisor oracle is mathematical arithmetic, independent of the implementation’s permitted-value tables.
4. Stable seam: validateWorkflow; fixture providers supply external data, not the asserted result.
5. Refactor tolerance: retained assertions concern returned data, accepted/rejected requests, persisted values or externally consumed diagnostics; private IDs/order, prose and geometry are pruned as listed.
6. Lowest owner: this package owns this shared contract. Retained cases exercise distinct grammar, input, state or protocol branches not replaced by transport/UI tests; duplicate helper/layer cases are deleted explicitly below.
Risk: low for pruning duplicate/presentation assertions; persistence, security, branching and migration behavior remain covered. Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/workflows/validate.test.ts`.

- **KEEP** `has no problems and parses ` — A valid connected workflow using prompt and upstream HTTP templates is blocked. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `rejects a non-object and non-JSON ` — The named behavior fails: rejects a non-object and non-JSON. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `maps record issues to fields, and still checks the blocks ` — The named behavior fails: maps record issues to fields, and still checks the blocks. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `a broken block reports its own problem with its id; the others are still checked ` — The named behavior fails: a broken block reports its own problem with its id; the others are still checked. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `unknown block types and bad edges are schema problems ` — The named behavior fails: unknown block types and bad edges are schema problems. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `nodes and edges must be lists ` — The named behavior fails: nodes and edges must be lists. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `counts blocks, connections, name length and size ` — The named behavior fails: counts blocks, connections, name length and size. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `unique ids and names, valid names ` — The named behavior fails: unique ids and names, valid names. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `each integrity rule ` — Missing endpoint, invalid handle/input, self-loop or duplicate edge is admitted; error must identify the bad edge. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `switch handles follow its cases ` — The named behavior fails: switch handles follow its cases. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `cycles ` — A cyclic graph is accepted, allowing a workflow that cannot progress. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `syntax errors in every template field ` — The named behavior fails: syntax errors in every template field. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `code source is JavaScript, not a template ` — The named behavior fails: code source is JavaScript, not a template. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `unknown blocks are errors; blocks that do not run first are warnings ` — The named behavior fails: unknown blocks are errors; blocks that do not run first are warnings. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `{{ }} in a shell script is refused with the fix ` — The named behavior fails: {{ }} in a shell script is refused with the fix. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `secrets: unknown names, whole-store reads, and prompts ` — The named behavior fails: secrets: unknown names, whole-store reads, and prompts. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `untrusted git text in a prompt warns ` — The named behavior fails: untrusted git text in a prompt warns. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `agent: empty prompt, saved prompt, chain length, max minutes ` — The named behavior fails: agent: empty prompt, saved prompt, chain length, max minutes. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `agent: the chain is checked against the host catalogue when one is given ` — The named behavior fails: agent: the chain is checked against the host catalogue when one is given. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `agent: continue must name an upstream agent ` — The named behavior fails: agent: continue must name an upstream agent. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `code: size, default export, memory, timeout ` — The named behavior fails: code: size, default export, memory, timeout. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `http: url and timeout ` — The named behavior fails: http: url and timeout. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `wait, block timeouts ` — The named behavior fails: wait, block timeouts. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `schedule: cron and zone, preset drift ` — The named behavior fails: schedule: cron and zone, preset drift. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `schedule: an 'every N' preset must divide the hour/day — an error on a save, a warning on a stored definition ` — The named behavior fails: schedule: an 'every N' preset must divide the hour/day — an error on a save, a warning on a stored definition. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `git: releases are GitHub only ` — The named behavior fails: git: releases are GitHub only. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `sub-workflow: unset, self, unknown ` — The named behavior fails: sub-workflow: unset, self, unknown. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `no trigger is information only ` — Manual-only workflow is incorrectly blocked by an error. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `blocks no trigger reaches never run ` — The named behavior fails: blocks no trigger reaches never run. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `pinned data ` — Missing-node pin fails to warn or oversized pin can be persisted. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `the result carries schema defaults ` — The named behavior fails: the result carries schema defaults. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.

## `packages/config/src/agent-accounts.test.ts`

Unit failure modes considered first: new account incorrectly selected, stored account rejected, unknown agent accepted, existing index moved.
Non-test callers: daemon agent-accounts.ts and index.ts.
1. Independent contract: README managed accounts and persisted account index compatibility.
2. Observable failure: the concrete incorrect result/rejection/data loss in each row below affects these callers.
3. Oracle: literal fixture data/results, fixed storage paths, protocol fields or known UTC/calendar instants; no expected result is generated with the function under test. The schedule divisor oracle is mathematical arithmetic, independent of the implementation’s permitted-value tables.
4. Stable seam: createDefaultAgentAccounts, parseAgentAccounts, agentAccountsFile; fixture providers supply external data, not the asserted result.
5. Refactor tolerance: retained assertions concern returned data, accepted/rejected requests, persisted values or externally consumed diagnostics; private IDs/order, prose and geometry are pruned as listed.
6. Lowest owner: this package owns this shared contract. Retained cases exercise distinct grammar, input, state or protocol branches not replaced by transport/UI tests; duplicate helper/layer cases are deleted explicitly below.
Risk: low for pruning duplicate/presentation assertions; persistence, security, branching and migration behavior remain covered. Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/config/src/agent-accounts.test.ts`.

- **KEEP** `createDefaultAgentAccounts is empty with null defaults ` — Fresh managed-account index selects an account that does not exist. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `parseAgentAccounts fills defaults and coerces missing fields ` — The named behavior fails: parseAgentAccounts fills defaults and coerces missing fields. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `parseAgentAccounts rejects an unknown agent ` — The named behavior fails: parseAgentAccounts rejects an unknown agent. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **REWRITE** `path helpers compose under the daemon dir ` — Startup looks at a new account-index path and appears to lose existing accounts. Remove the unused agentAccountHome assertion and implementation; retain independently fixed agent-accounts.json storage path used by daemon startup.

## `packages/config/src/index.test.ts`

Unit failure modes considered first: account pin/owner lost on restart; traversal accepted; optional restart marks destroy old heads or disappear.
Non-test callers: daemon sessions.ts, agent-host/store/index.ts, MCP addressing and filesystem routes.
1. Independent contract: AGENTS.md filesystem containment, tolerant persisted sessions and thread heads; goals design §§5.5/5.7; legacy proxy retirement compatibility.
2. Observable failure: the concrete incorrect result/rejection/data loss in each row below affects these callers.
3. Oracle: literal fixture data/results, fixed storage paths, protocol fields or known UTC/calendar instants; no expected result is generated with the function under test. The schedule divisor oracle is mathematical arithmetic, independent of the implementation’s permitted-value tables.
4. Stable seam: parseSessionsConfig, parseAgentThreadHead, isValidName, assertInsideFsRoot; fixture providers supply external data, not the asserted result.
5. Refactor tolerance: retained assertions concern returned data, accepted/rejected requests, persisted values or externally consumed diagnostics; private IDs/order, prose and geometry are pruned as listed.
6. Lowest owner: this package owns this shared contract. Retained cases exercise distinct grammar, input, state or protocol branches not replaced by transport/UI tests; duplicate helper/layer cases are deleted explicitly below.
Risk: low for pruning duplicate/presentation assertions; persistence, security, branching and migration behavior remain covered. Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/config/src/index.test.ts`.

- **KEEP** `isValidName rejects traversal and empties ` — The named behavior fails: isValidName rejects traversal and empties. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `sessionRecordSchema round-trips accountId so reattach keeps the account pin ` — The named behavior fails: sessionRecordSchema round-trips accountId so reattach keeps the account pin. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `sessionRecordSchema keeps a workflow owner and drops a malformed one, never the record ` — The named behavior fails: sessionRecordSchema keeps a workflow owner and drops a malformed one, never the record. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `assertInsideFsRoot allows in-root paths and rejects escapes ` — The named behavior fails: assertInsideFsRoot allows in-root paths and rejects escapes. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `legacy proxy-home tabs and thread heads remain readable after launcher retirement ` — The named behavior fails: legacy proxy-home tabs and thread heads remain readable after launcher retirement. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `a head carrying the goal-resume marker round-trips it ` — The named behavior fails: a head carrying the goal-resume marker round-trips it. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `a head written before goals — no marker — still parses, and says no ` — The named behavior fails: a head written before goals — no marker — still parses, and says no. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `a malformed goal-resume marker is dropped, never the whole head ` — The named behavior fails: a malformed goal-resume marker is dropped, never the whole head. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `a head carrying the goal-hold marker round-trips it, beside the other two ` — The named behavior fails: a head carrying the goal-hold marker round-trips it, beside the other two. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `a head without the goal-hold marker says no, and writes none back ` — The named behavior fails: a head without the goal-hold marker says no, and writes none back. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `a malformed goal-hold marker is dropped, never the whole head ` — The named behavior fails: a malformed goal-hold marker is dropped, never the whole head. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `a stamped continuation marker round-trips beside both goal marks — through JSON, as meta.json holds it ` — The named behavior fails: a stamped continuation marker round-trips beside both goal marks — through JSON, as meta.json holds it. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `a malformed continuation stamp reads as unstamped — an older host's marker — never an unreadable head ` — The named behavior fails: a malformed continuation stamp reads as unstamped — an older host's marker — never an unreadable head. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.

## `packages/config/src/saved-prompts-config.test.ts`

Unit failure modes considered first: stored prompts lost or overwritten on version mismatch; malicious key mutates prototype.
Non-test callers: daemon saved-prompts.ts and index.ts.
1. Independent contract: AGENTS.md preserve unknown persisted fields/records; saved-prompt storage format.
2. Observable failure: the concrete incorrect result/rejection/data loss in each row below affects these callers.
3. Oracle: literal fixture data/results, fixed storage paths, protocol fields or known UTC/calendar instants; no expected result is generated with the function under test. The schedule divisor oracle is mathematical arithmetic, independent of the implementation’s permitted-value tables.
4. Stable seam: parseSavedPromptsConfig, savedPromptsPath; fixture providers supply external data, not the asserted result.
5. Refactor tolerance: retained assertions concern returned data, accepted/rejected requests, persisted values or externally consumed diagnostics; private IDs/order, prose and geometry are pruned as listed.
6. Lowest owner: this package owns this shared contract. Retained cases exercise distinct grammar, input, state or protocol branches not replaced by transport/UI tests; duplicate helper/layer cases are deleted explicitly below.
Risk: low for pruning duplicate/presentation assertions; persistence, security, branching and migration behavior remain covered. Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/config/src/saved-prompts-config.test.ts`.

- **KEEP** `savedPromptsPath lives beside the other daemon-owned indexes ` — The named behavior fails: savedPromptsPath lives beside the other daemon-owned indexes. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `a well-formed library round-trips unchanged ` — The named behavior fails: a well-formed library round-trips unchanged. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **REWRITE** `bad entries are set aside one by one, verbatim; the rest of the library loads ` — The named behavior fails: bad entries are set aside one by one, verbatim; the rest of the library loads. Use deep value equality for rejected persisted JSON; object reference identity is not a storage contract.
- **REWRITE** `a repeated id keeps its first record; the others are set aside, not dropped ` — The named behavior fails: a repeated id keeps its first record; the others are set aside, not dropped. Keep first-record preference and duplicate JSON preservation; remove object-reference identity requirement.
- **REWRITE** `unknown top-level keys are kept, exactly as found ` — The named behavior fails: unknown top-level keys are kept, exactly as found. Keep unknown values and safe own __proto__ storage; remove JSON property-order assertion.
- **KEEP** `optional fields default, limits are NOT re-applied, and unknown fields pass through ` — The named behavior fails: optional fields default, limits are NOT re-applied, and unknown fields pass through. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **REWRITE** `the outer shape still throws — an unknown version included — so the file is not rewritten ` — The named behavior fails: the outer shape still throws — an unknown version included — so the file is not rewritten. Retain explicit rejection/default result and remove exact diagnostic wording.

## `packages/config/src/usage-prefs-migrate.test.ts`

Unit failure modes considered first: legacy opt-out lost, master disable ignored, older app config unreadable.
Non-test callers: daemon usage.ts; UI UsageOverview.tsx and UsageWidget.tsx.
1. Independent contract: persisted app-config migration and README optional per-agent usage widget.
2. Observable failure: the concrete incorrect result/rejection/data loss in each row below affects these callers.
3. Oracle: literal fixture data/results, fixed storage paths, protocol fields or known UTC/calendar instants; no expected result is generated with the function under test. The schedule divisor oracle is mathematical arithmetic, independent of the implementation’s permitted-value tables.
4. Stable seam: usagePrefsSchema, parseAppConfig, usageAgentEnabled; fixture providers supply external data, not the asserted result.
5. Refactor tolerance: retained assertions concern returned data, accepted/rejected requests, persisted values or externally consumed diagnostics; private IDs/order, prose and geometry are pruned as listed.
6. Lowest owner: this package owns this shared contract. Retained cases exercise distinct grammar, input, state or protocol branches not replaced by transport/UI tests; duplicate helper/layer cases are deleted explicitly below.
Risk: low for pruning duplicate/presentation assertions; persistence, security, branching and migration behavior remain covered. Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/config/src/usage-prefs-migrate.test.ts`.

- **KEEP** `legacy claude/codex booleans migrate into agents record ` — The named behavior fails: legacy claude/codex booleans migrate into agents record. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `new agents record passes through ` — An explicit per-agent disable is lost or a newly supported unspecified agent is disabled. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `disabled master switch overrides per-agent ` — The named behavior fails: disabled master switch overrides per-agent. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.
- **KEEP** `usage defaults and legacy app migration preserve supported chip preferences ` — The named behavior fails: usage defaults and legacy app migration preserve supported chip preferences. Retains literal expected data/state for this distinct input; no stronger remaining case exercises this same failure.

## Support/seam plan recorded before edits

- Remove `agentAccountHome`: repository references show only its test calls it; keep daemon-used `agentAccountsDir` and `agentAccountsFile`.
- Remove unused synchronous `evaluateRule`, `evaluateRules`, `evaluateSwitch`; no production caller, no published SDK (package is private), no design/MCP/API documentation promises these names. The actual daemon uses async variants. Keep rule behavior tests through that seam; matcher executes native RegExp rather than manufacturing the expected boolean.
- Make same-module prompt formatter/sentinel exports private where repository references find no consumer. Keep `projectNamesFromPath`, used by the UI.
- Shared workflow `testing.ts` remains needed by patch/validation/templates and daemon tests. No orphan fixture/snapshot file results from these deletions.
- No production behavior change, dependency change, test-command suppression or live daemon execution is intended.

## Validation and completion

Completed disposition counts: {'KEEP': 124, 'DELETE': 8, 'REWRITE': 40}.

- Baseline scoped test command: 172 passed, 0 failed.
- After pruning: 164 retained cases. The first scoped run passed 152 and caught 12 incomplete async-test call rewrites; corrected the test codemod without changing production behavior. Rerun of all 12 affected rule tests: 12 passed, 0 failed. No baseline product failure was found.
- `pnpm --filter @orquester/api typecheck` and `pnpm --filter @orquester/config typecheck`: passed.
- Scoped `git diff --check`: passed; final diff reviewed. Root agent owns repository-wide checks and integration.
- Completed support cleanup: removed `agentAccountHome`, three unused synchronous rule implementations and their private regex-result wrapper; made thirteen unused prompt-formatter/sentinel exports module-private. No fixtures or snapshots orphaned.
- Daemon workflow owner retains its unique nested-schema preservation/prototype-ID/redaction regressions at their existing direct config/API seams; those are not duplicates of this scope.
