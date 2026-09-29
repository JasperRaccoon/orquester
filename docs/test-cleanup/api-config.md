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

## `packages/api/src/prompt-variables.test.ts`

Unit failure modes considered first: wrong context or timezone inserted; failed/cancelled read sends partial prompt.
Non-test callers: UI saved-prompt source and daemon workflows/nodes/agent prompt rendering.
1. Independent contract: workflow design §5.3 resolver and timezone/failure semantics; public saved-prompt variables.
4. Stable seam: resolvePromptVariables; fixture providers supply external data, not the asserted result.
Risk: low for pruning duplicate/presentation assertions; persistence, security, branching and migration behavior remain covered. Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/prompt-variables.test.ts`.

- **DELETE** `text inserted by a workflow expression and escaped stays literal ` — The named behavior fails: text inserted by a workflow expression and escaped stays literal. Repeats escape/render semantics already owned by saved-prompts.test.ts and expression escapeValue coverage; no resolver-specific behavior beyond those contracts.

## `packages/api/src/saved-prompts.test.ts`

Unit failure modes considered first: literal prompt expanded, unknown braces modified, empty/missing values confused.
Non-test callers: UI saved-prompts/variables.ts, chat history; workflow prompt resolver.
1. Independent contract: public saved-prompt template language and history Save as prompt behavior.
4. Stable seam: renderPromptTemplate, escapePromptVariables, promptVariablesUsed; fixture providers supply external data, not the asserted result.
Risk: low for pruning duplicate/presentation assertions; persistence, security, branching and migration behavior remain covered. Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/saved-prompts.test.ts`.

- **DELETE** `leaves text without known variables alone ` — The named behavior fails: leaves text without known variables alone. Duplicates the stronger save-and-render case, which already contains plain text, unknown names and code braces; no distinct caller failure.

## `packages/api/src/workflows/expressions.test.ts`

Unit failure modes considered first: bad grammar/data conversion or renamed reference; secret/prototype traversal; expression resource limit ignored.
Non-test callers: workflow node executors, validator, patcher, UI clipboard.
1. Independent contract: workflow design §3.3 expression grammar, safe reads and two-pass prompt escaping; public expression API limits.
4. Stable seam: renderTemplate, renderTemplateValue, parseTemplate, hasTemplate, rewriteNodeReferences; fixture providers supply external data, not the asserted result.
Risk: low for pruning duplicate/presentation assertions; persistence, security, branching and migration behavior remain covered. Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/workflows/expressions.test.ts`.

- **REWRITE** `reports syntax errors and keeps the broken text literal ` — The named behavior fails: reports syntax errors and keeps the broken text literal. Retain grammar, missing-value or security failure via literal output and warning/error presence; remove diagnostic English fragments. Specific path data remains asserted where the path identifies the affected expression.
- **REWRITE** `an unclosed {{ is an error and the rest is text ` — The named behavior fails: an unclosed {{ is an error and the rest is text. Retain grammar, missing-value or security failure via literal output and warning/error presence; remove diagnostic English fragments. Specific path data remains asserted where the path identifies the affected expression.
- **REWRITE** `caps path depth ` — The named behavior fails: caps path depth. Retain grammar, missing-value or security failure via literal output and warning/error presence; remove diagnostic English fragments. Specific path data remains asserted where the path identifies the affected expression.
- **REWRITE** `does not parse a template over the length cap ` — The named behavior fails: does not parse a template over the length cap. Retain grammar, missing-value or security failure via literal output and warning/error presence; remove diagnostic English fragments. Specific path data remains asserted where the path identifies the affected expression.
- **REWRITE** `handles many expressions and hostile input without blowing up ` — The named behavior fails: handles many expressions and hostile input without blowing up. Retain grammar, missing-value or security failure via literal output and warning/error presence; remove diagnostic English fragments. Specific path data remains asserted where the path identifies the affected expression.
- **REWRITE** `a missing path renders empty and warns with the expression ` — The named behavior fails: a missing path renders empty and warns with the expression. Retain grammar, missing-value or security failure via literal output and warning/error presence; remove diagnostic English fragments. Specific path data remains asserted where the path identifies the affected expression.
- **REWRITE** `filter misuse warns and renders empty ` — The named behavior fails: filter misuse warns and renders empty. Retain grammar, missing-value or security failure via literal output and warning/error presence; remove diagnostic English fragments. Specific path data remains asserted where the path identifies the affected expression.
- **REWRITE** `a cyclic value warns rather than throwing ` — The named behavior fails: a cyclic value warns rather than throwing. Retain grammar, missing-value or security failure via literal output and warning/error presence; remove diagnostic English fragments. Specific path data remains asserted where the path identifies the affected expression.
- **REWRITE** `broken expressions stay as written and warn ` — The named behavior fails: broken expressions stay as written and warn. Retain grammar, missing-value or security failure via literal output and warning/error presence; remove diagnostic English fragments. Specific path data remains asserted where the path identifies the affected expression.
- **REWRITE** `own JSON keys that look dangerous are refused at parse time ` — The named behavior fails: own JSON keys that look dangerous are refused at parse time. Retain grammar, missing-value or security failure via literal output and warning/error presence; remove diagnostic English fragments. Specific path data remains asserted where the path identifies the affected expression.
- **REWRITE** `secrets must name exactly one secret ` — The named behavior fails: secrets must name exactly one secret. Retain grammar, missing-value or security failure via literal output and warning/error presence; remove diagnostic English fragments. Specific path data remains asserted where the path identifies the affected expression.
- **DELETE** `reports missing separately from the value ` — The named behavior fails: reports missing separately from the value. Asserts intermediate evaluator bookkeeping after parser helper assembly; renderTemplateValue missing output and rule presence semantics catch the actual caller failure.
- **DELETE** `round-trips several references in one template ` — The named behavior fails: round-trips several references in one template. Duplicates multiple-reference rewrite coverage in the preceding dot/bracket case and patch rename integration; round-trip adds no independently specified failure.

## `packages/api/src/workflows/graph.test.ts`

Unit failure modes considered first: wrong runnable/skipped blocks, premature joins, missing partial-run descendants or accepted cycles.
Non-test callers: daemon workflow engine; UI connection/steps/run-view; validator.
1. Independent contract: workflow design §3.4 readiness, dead-path elimination, DAG and merge semantics.
4. Stable seam: computeReadiness, upstreamOf, downstreamOf, reachableFromTriggers, topologicalOrder; fixture providers supply external data, not the asserted result.
Risk: low for pruning duplicate/presentation assertions; persistence, security, branching and migration behavior remain covered. Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/workflows/graph.test.ts`.

- **DELETE** `topological order, ties by definition order, notes excluded ` — The named behavior fails: topological order, ties by definition order, notes excluded. Pins helper tie order and separately inventories executable nodes. Readiness/outline retained cases protect executable actions; tie order among independent blocks is not user behavior.
- **DELETE** `cycles ` — A cyclic graph is accepted, allowing a workflow that cannot progress. Duplicates DAG rejection owned by validate.test.ts cycles; SCC ordering and topological helper null are implementation-level intermediates.
- **DELETE** `ignores edges to missing nodes and to notes ` — The named behavior fails: ignores edges to missing nodes and to notes. Pins adjacency helper treatment of invalid edges; validate.test.ts each integrity rule and outline nonactionable-note behavior own accepted graph behavior.

## `packages/api/src/workflows/outline.test.ts`

Unit failure modes considered first: a join displayed twice/mislinked; unreachable executable step hidden; cyclic edit hangs view.
Non-test callers: UI outline-display, canvas-fit and Steps view.
1. Independent contract: workflow design §7.4 Steps view actionable order and join references.
4. Stable seam: buildStepOutline; fixture providers supply external data, not the asserted result.
Risk: low for pruning duplicate/presentation assertions; persistence, security, branching and migration behavior remain covered. Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/workflows/outline.test.ts`.

## `packages/api/src/workflows/patch.test.ts`

Unit failure modes considered first: partial update persists; references disconnect; invalid mutation accepted; created graph cannot be addressed.
Non-test callers: daemon workflow service; UI editor operations.
1. Independent contract: workflow design §8.2 atomic patch operations and public CreateWorkflowRequest.
4. Stable seam: applyWorkflowPatch, createWorkflowFromRequest; fixture providers supply external data, not the asserted result.
Risk: low for pruning duplicate/presentation assertions; persistence, security, branching and migration behavior remain covered. Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/workflows/patch.test.ts`.

- **REWRITE** `add_node mints unique ids and names, fills defaults and merges config ` — The named behavior fails: add_node mints unique ids and names, fills defaults and merges config. Keep uniqueness, config defaults and resolved connection endpoints; remove dependence on ID-generator invocation order.
- **REWRITE** `add_node keeps a given id, name and position; refuses duplicates, bad names, bad types, bad configs ` — The named behavior fails: add_node keeps a given id, name and position; refuses duplicates, bad names, bad types, bad configs. Keep caller identity and explicit invalid-request rejection; remove coordinate equality and diagnostic copy.
- **REWRITE** `update_node refuses id/type changes, unknown fields and invalid configs ` — The named behavior fails: update_node refuses id/type changes, unknown fields and invalid configs. Assert WorkflowPatchError and failing operation index instead of diagnostic copy.
- **REWRITE** `rename_node rewrites every template reference and session.fromNode ` — The named behavior fails: rename_node rewrites every template reference and session.fromNode. Keep rewritten prompt/session/URL/header data and invalid-rename rejection; remove duplicate validator round-trip and incidental node count.
- **REWRITE** `connect checks handles, inputs, self-loops and duplicates ` — The named behavior fails: connect checks handles, inputs, self-loops and duplicates. Keep source-handle data and typed/indexed rejection for each invalid operation, without English error matching.
- **REWRITE** `disconnect by id or by endpoints ` — The named behavior fails: disconnect by id or by endpoints. Assert removal by edge identity/endpoints and typed rejection; remove incidental edge count and error prose.
- **REWRITE** `settings, project, enabled, name, pins ` — Requested settings replace untouched notification fields, project/name fails to change, or cleared pin/description survives. Keep public mutation results and typed/indexed rejection; remove diagnostic wording.
- **REWRITE** `is atomic: the failing op is named and nothing applies ` — The named behavior fails: is atomic: the failing op is named and nothing applies. Keep atomic source preservation and public opIndex, removing duplicate invocation solely checking copy.
- **REWRITE** `mints ids and names, applies defaults and resolves edge refs by name ` — The named behavior fails: mints ids and names, applies defaults and resolves edge refs by name. Keep generated identity uniqueness, defaults and edge resolution; remove injected ID order and duplicate validator invocation.
- **DELETE** `create preserves caller-provided positions ` — The named behavior fails: create preserves caller-provided positions. Coordinate assertion without visual regression requirement; no execution, navigation or data contract beyond geometry is asserted.

## `packages/api/src/workflows/rules.test.ts`

Unit failure modes considered first: wrong branch/coercion; missed rule warnings; unsafe regex searched; fallback route lost.
Non-test callers: daemon workflows/nodes condition execution.
1. Independent contract: workflow design §4 IF/Switch operators and public async rule semantics; regex resource safeguards.
4. Stable seam: evaluateRuleAsync, evaluateRulesAsync, evaluateSwitchAsync; fixture providers supply external data, not the asserted result.
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
4. Stable seam: presetToCron, validateCron, nextRuns, nextScheduleRun, scheduleIntervalProblem; fixture providers supply external data, not the asserted result.
Risk: low for pruning duplicate/presentation assertions; persistence, security, branching and migration behavior remain covered. Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/workflows/schedule.test.ts`.

- **REWRITE** `refuses the rest with a reason ` — The named behavior fails: refuses the rest with a reason. Keep invalid cron/timezone matrix and nonempty rejection reason; discard exact English diagnostic fragments.

## `packages/api/src/workflows/templates.test.ts`

Unit failure modes considered first: starter cannot be enabled/configured; Jira ticket data omitted; wrong transition posted.
Non-test callers: workflow rail creation and code-block executor.
1. Independent contract: workflow design §7.1 three starter templates and Jira workflow behavior; Jira HTTP request protocol.
4. Stable seam: buildTemplate and actual emitted code module default export; fixture providers supply external data, not the asserted result.
Risk: low for pruning duplicate/presentation assertions; persistence, security, branching and migration behavior remain covered. Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/workflows/templates.test.ts`.

- **REWRITE** `every template builds, is disabled, and validates with zero errors ` — The named behavior fails: every template builds, is disabled, and validates with zero errors. Use the three independently required starter IDs rather than looping the production declaration, which can silently shrink; retain disabled/project/timezone/validity contract.
- **REWRITE** `MarkDone transitions what the agent fixed ` — The named behavior fails: MarkDone transitions what the agent fixed. Retain emitted Jira request and moved/failed/skipped records; remove exact invalid-reply error wording.

## `packages/api/src/workflows/triggers-text.test.ts`

Unit failure modes considered first: wrong repository identity displayed for supported clone syntax.
Non-test callers: workflow trigger summaries and daemon workflow summary.
1. Independent contract: public repository display-name parser for HTTPS, SSH, SCP and Bitbucket clone URLs.
4. Stable seam: repoDisplayName; fixture providers supply external data, not the asserted result.
Risk: low for pruning duplicate/presentation assertions; persistence, security, branching and migration behavior remain covered. Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/workflows/triggers-text.test.ts`.

## `packages/api/src/workflows/validate.test.ts`

Unit failure modes considered first: invalid workflow enabled or good workflow blocked; field diagnostics lost; unsafe shell/secrets accepted.
Non-test callers: daemon write/enable paths, MCP validation and UI editor.
1. Independent contract: workflow design §§3.3/3.4/4/7.2 and public WorkflowProblem codes; persisted config/security limits.
4. Stable seam: validateWorkflow; fixture providers supply external data, not the asserted result.
Risk: low for pruning duplicate/presentation assertions; persistence, security, branching and migration behavior remain covered. Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/api/src/workflows/validate.test.ts`.

## `packages/config/src/agent-accounts.test.ts`

Unit failure modes considered first: new account incorrectly selected, stored account rejected, unknown agent accepted, existing index moved.
Non-test callers: daemon agent-accounts.ts and index.ts.
1. Independent contract: README managed accounts and persisted account index compatibility.
4. Stable seam: createDefaultAgentAccounts, parseAgentAccounts, agentAccountsFile; fixture providers supply external data, not the asserted result.
Risk: low for pruning duplicate/presentation assertions; persistence, security, branching and migration behavior remain covered. Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/config/src/agent-accounts.test.ts`.

- **REWRITE** `path helpers compose under the daemon dir ` — Startup looks at a new account-index path and appears to lose existing accounts. Remove the unused agentAccountHome assertion and implementation; retain independently fixed agent-accounts.json storage path used by daemon startup.

## `packages/config/src/index.test.ts`

Unit failure modes considered first: account pin/owner lost on restart; traversal accepted; optional restart marks destroy old heads or disappear.
Non-test callers: daemon sessions.ts, agent-host/store/index.ts, MCP addressing and filesystem routes.
1. Independent contract: AGENTS.md filesystem containment, tolerant persisted sessions and thread heads; goals design §§5.5/5.7; legacy proxy retirement compatibility.
4. Stable seam: parseSessionsConfig, parseAgentThreadHead, isValidName, assertInsideFsRoot; fixture providers supply external data, not the asserted result.
Risk: low for pruning duplicate/presentation assertions; persistence, security, branching and migration behavior remain covered. Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/config/src/index.test.ts`.

## `packages/config/src/saved-prompts-config.test.ts`

Unit failure modes considered first: stored prompts lost or overwritten on version mismatch; malicious key mutates prototype.
Non-test callers: daemon saved-prompts.ts and index.ts.
1. Independent contract: AGENTS.md preserve unknown persisted fields/records; saved-prompt storage format.
4. Stable seam: parseSavedPromptsConfig, savedPromptsPath; fixture providers supply external data, not the asserted result.
Risk: low for pruning duplicate/presentation assertions; persistence, security, branching and migration behavior remain covered. Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/config/src/saved-prompts-config.test.ts`.

- **REWRITE** `bad entries are set aside one by one, verbatim; the rest of the library loads ` — The named behavior fails: bad entries are set aside one by one, verbatim; the rest of the library loads. Use deep value equality for rejected persisted JSON; object reference identity is not a storage contract.
- **REWRITE** `a repeated id keeps its first record; the others are set aside, not dropped ` — The named behavior fails: a repeated id keeps its first record; the others are set aside, not dropped. Keep first-record preference and duplicate JSON preservation; remove object-reference identity requirement.
- **REWRITE** `unknown top-level keys are kept, exactly as found ` — The named behavior fails: unknown top-level keys are kept, exactly as found. Keep unknown values and safe own __proto__ storage; remove JSON property-order assertion.
- **REWRITE** `the outer shape still throws — an unknown version included — so the file is not rewritten ` — The named behavior fails: the outer shape still throws — an unknown version included — so the file is not rewritten. Retain explicit rejection/default result and remove exact diagnostic wording.

## `packages/config/src/usage-prefs-migrate.test.ts`

Unit failure modes considered first: legacy opt-out lost, master disable ignored, older app config unreadable.
Non-test callers: daemon usage.ts; UI UsageOverview.tsx and UsageWidget.tsx.
1. Independent contract: persisted app-config migration and README optional per-agent usage widget.
4. Stable seam: usagePrefsSchema, parseAppConfig, usageAgentEnabled; fixture providers supply external data, not the asserted result.
Risk: low for pruning duplicate/presentation assertions; persistence, security, branching and migration behavior remain covered. Validation: `pnpm exec node --import tsx --import ./scripts/test/assert-ok.mjs --test packages/config/src/usage-prefs-migrate.test.ts`.

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
