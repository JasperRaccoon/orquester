# MCP workflows: current-suite cleanup

Dispositions recorded before edits for all 20 current tests in `apps/daemon/src/mcp/tools/workflows.test.ts`. This records completed implementation, not historical audit-only findings.

Independent sources: `docs/orquester-mcp.md` §12 (inputs, authoring, runs, secrets, size/errors), current workflow REST request/response types and `AGENTS.md` requirements to use DaemonApi and keep secret values host-only. Read owners: tools/workflows.ts, workflows-guide.ts, workflows.testing.ts, shared MCP testing/tool/result/error seams and the current documented contracts.

Isolated-owner failures considered before retention: a tool can resolve/send the wrong project or command fields; accept malformed inputs; drop server error codes/index/problem details; leak secrets/internal paths; truncate structured definitions invisibly; lose UTF-8 output bytes between pages; miss a run event or leak polling/subscriptions; return caller-visible block data out of order. The old fake additionally implemented graph creation, validation, patch atomicity, server filtering, overlap and run completion; those are not MCP-owned behavior and are removed from this suite.

Full six-bar rationale for **every KEEP/REWRITE**, with the exact case-specific contract below:

1. §12 explicitly specifies the named input/result/error/byte/secret/wait contract; fixture response values are independently selected.
2. Each row identifies a wrong request, response, data omission/leak or stuck/leaked wait visible to an MCP caller.
3. Expected fields, IDs, messages containing literal public keys, error codes and data bytes are not computed using the tool or daemon workflow core; all canned responses are fixed transport evidence, not a mocked implementation of the asserted transformation.
4. Calls exercise the actual exported tool definition schema and run handler via its production DaemonApi boundary.
5. Assertions use protocol data/state and essential diagnostic keys rather than exact English sentences, generated IDs, private collaborator shape or geometry; implementation-only identity assertions in the call helper are removed.
6. These cases own MCP-specific transformation and waiting. API/service tests own validation, graph storage and server policy. The real workflow engine guide E2E is retained by the engine agent, as is its draft-placeholder route test; repeated fake workflows do not substitute for either.

All workflow production tools are consumed through `workflowTools` in the MCP server registry; each calls DaemonApi request/subscribe. No production caller references `FakeWorkflowDaemon` or workflows.testing.ts. JIRA_FIXER_EXAMPLE/JIRA_FIXER_EDIT_OPS remain used by the published guide and the real guide E2E and are not removed.

Risk: low; no production behavior changes were made. Losing fake domain coverage is intentional because real API/service/engine owner tests remain. Shared FakeDaemonApi remains in use across MCP tests and is outside this cleanup's ownership.

Validation per row, from `apps/daemon`:

```sh
pnpm exec node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test src/mcp/tools/workflows.test.ts
```

Root integrates daemon typecheck and repository gates.

| Original test | Disposition | Concrete contract / pruning reason / stronger owner |
| --- | --- | --- |
| list_workflow_block_types filters the requested block type | **KEEP** | A requested type must return only that daemon catalog entry, without the broad authoring guide; this is tool-side filtering distinct from catalog declaration inventory. |
| list_workflow_block_types: schemas too big for one result are omitted largest first and named | **REWRITE** | Keep largest-first schema omission and cap compliance using independently sized canned schemas; remove production catalog generation in FakeWorkflowDaemon, which supplied the tested inventory. |
| create_workflow: names in edges, project resolved, auto-layout, host time zone, disabled by default, problems returned | **REWRITE** | Keep names in outbound edges, resolved project path, automatic layout request, disabled default, host timezone and returned revision/problems. Replace createJira and fake core creation with literal request/response fixtures; real engine E2E owns validating the published guide. |
| create_workflow: a temp project passes through; unknown projects and bad arguments are refused | **REWRITE** | Keep temp target pass-through and actual strict schema/project-resolution rejection. Use canned write response; do not implement storage or creation in a fake. Literal argument field paths are public errors, English wording is not frozen. |
| create_workflow: a refused edge is named by its index; enabling with errors carries the problems in the text and detail | **REWRITE** | Keep translation of daemon combined node/edge opIndex to edges[i], and validation problem codes in error detail/text. Replace fake validation with explicit error envelopes and discard incidental prose/toSafeToolError duplication. |
| get_workflow: definition, revision, problems and connections; one block by name; unknown ids get the hint | **REWRITE** | Keep node-name selection and incident-edge membership by edge IDs, revision and missing-node/workflow diagnostics. Drop exact rendered connection prose and Jira graph counts; static stored definition avoids validating a generated fixture against itself. |
| get_workflow: a definition too big for one result cuts its long texts and names them | **REWRITE** | Keep large source truncation with exact field-path reporting and small source intact on read/write answers; feed the same explicit large stored response to each actual tool, no fake create implementation. |
| update_workflow: a stale revision says to re-read; a failing op is named by index; nothing is saved | **REWRITE** | Keep revision-conflict hint, legacy missing-opIndex diagnostic recovery and authoritative daemon opIndex. Drop fake atomicity claim and exact sentence punctuation; real workflow service owns transaction rollback. |
| update_workflow: strict op shapes; set_project resolves a project; disconnect needs a connection | **REWRITE** | Keep public op-schema rejection and resolved set_project/disconnect request data. Assert emitted protocol fields instead of accepting a fake patch implementation's resulting state. |
| validate_workflow fills draft identity and returns daemon validation problems with errors first | **REWRITE** | Keep invalid result and error/warning ordering/counts from a canned daemon validation response. Remove synthetic draft identity spelling, which has no specified byte value; workflow engine real-route placeholder-draft regression owns required missing fields. |
| list_workflows: summaries, filtered by a resolved project | **REWRITE** | Keep project resolution into the daemon query and public summary projection. Delete fake-filtered collection assertions: daemon list filtering is owned by real service, not MCP. |
| run_workflow: without wait answers the runId; the overlap policy's skip is explained; force passes through | **REWRITE** | Keep runId result and input/force request mapping and overlap-result interpretation. Supply explicit run/skip responses; remove fake's overlap decision and fake run counter. |
| run_workflow {wait}: the bus ends the wait; every block's status and output come back | **REWRITE** | Keep event-driven completion and returned definition-order block status/handle/output/session/hops/finalOutput. A canned terminal record and event provide transport data only; no fake engine settles blocks. |
| run_workflow {wait}: a timeout answers where the run is | **REWRITE** | Keep timeout returning unfinished current run state and subscription cleanup, using mock timers/performance and settled setup rather than an actual one-second delay. |
| run_workflow wait rereads a silently finished run and releases its subscription on abort | **REWRITE** | Keep periodic reread when a terminal event is missed and unsubscribe on abort. Replace fake run-map mutation with a canned terminal GET response; the real tool still owns all waiting. |
| get_workflow_run: outputs fitted to the cap with outputTruncated; includeOutputs:false; one block's output paged | **REWRITE** | Keep per-output fitting, daemon preview flags, includeOutputs false, small-output completeness and multi-byte paginated reassembly by block name. Canned output endpoints replace fake output storage; wrong cursors/escaping lose caller data. |
| delete_workflow needs confirm: true | **KEEP** | Strict confirm:true is the deletion tool's independently specified destructive-action boundary; rejected false/missing cases and successful confirmed call protect the same public schema. |
| secrets: names only; set is write-only, scoped by workflowId, warns on a short value; bad names refused | **REWRITE** | Keep secrets write-only replies, scoped query, short-secret warning, names-only listing despite malicious extra value fields and name/size limits. Remove a second listing of the same fake response and meaningless absence-of-short-string check. |
| get_workflow maps workflow errors, bounds problem detail and hides internal failures | **KEEP** | Workflow errors preserve codes, prioritize error problems within the documented 100-item cap and redact generic internal failures; literal secret path leak check is security behavior. |
| get_workflow / create_workflow: 200 blocks too big even cut are outlined, never byte-cut by ok() | **REWRITE** | Keep 200-node outline fallback with all identities preserved and per-block full config recovery; supply a static large stored response instead of fake create generation. This catches structural loss at the MCP byte cap, not UI row geometry. |

## Support removed

Removed `apps/daemon/src/mcp/tools/workflows.testing.ts` (184 lines): fake create/patch/core validation/catalog/run/overlap/filtering/output storage. Replaced it with small literal fixtures in the test file and shared FakeDaemonApi route answers. Removed repeated `createJira`, direct production guide imports, and the call helper's ok(result).structuredContent reference-identity assertion; result byte bounds remain explicit externally documented contracts. No production flags/exports/hooks are needed to support retained tests.

## Validation results

Completed cleanup of all 20 original cases: 3 KEEP and 17 REWRITE. The standalone test file grows by 8 lines while deleting 184 lines of fake domain support, for 176 fewer test/support lines.

- Baseline focused command above: 20 passed, zero failed/skipped.
- Final focused command above: 20 passed, zero failed/skipped; repeated after dropping an incidental truncation-marker spelling assertion, again 20 passed.
- `pnpm --filter @orquester/daemon typecheck` reported only unrelated errors in `adapters/codex/units.test.ts` (unsupported findLast, missing fixture logPath, unsupported force option). Sent those diagnostics to root for the owning agent; root's integrated check verifies their correction.
- Scoped `git diff --check` passed. Reviewed the final test/support diff and confirmed no remaining imports of the removed workflow fake.
