# Test cleanup record

This directory archives earlier cleanup decisions, including the incoming `7f3516cd` cleanup and older linked reports. [The slop audit](../slop-audit.md) records the final merged decisions and verification; it supersedes historical dispositions here when review retained an assertion or production interface.

The cleanup starting at `9675e822` is summarized in [current.md](current.md). Its full original disposition ledgers are preserved in [commit `7f3516cd`](https://github.com/JasperRaccoon/orquester/commit/7f3516cd). The scope summaries retain concrete change reasons, risks, validation, and unique safeguards; repetitive unchanged-test inventories and temporary runner log paths are omitted. The report below describes the earlier cleanup from `008f84e6`.

Cleanup is completed and verified across the original repository and the incoming remote changes. These reports record every disposition, its independent contract or deletion reason, and validation. The merge preserves upstream commits `b72cefb2` and `8dcbdc61`, which retire the model proxy and its launchers; their new and changed tests received the same audit.

The baseline is commit `008f84e6`: **497 test/check files**, comprising 466 `.test.ts` files and 31 standalone `.check.ts` files, with **7,558 named test definitions**. Parameterized definitions count once in this inventory; their runtime executions can be more numerous. The deployment smoke script adds ten original scenarios. The baseline repository test command passed.

The audit uses DELETE by default. Every original named definition has a path and DELETE, REWRITE or KEEP decision in the linked scope reports. Standalone checks are recorded by assertion behavior, and the smoke report records every original scenario. Shared contract records plus each retained case's specific scenario justify all six requirements: independent specification, recognizable failure, independent expectation, stable interface, refactor tolerance and lowest coverage owner. Reports also identify stronger remaining coverage, production callers, removal risk, validation commands and removed support/seams.

A reconciliation against the original file and AST case inventories found **no missing original paths or named definitions**, including the standalone checks and smoke scenarios. This checks report completeness; it does not substitute for source review or final validation. Explicit follow-up decisions supersede the affected initial dispositions.

| Scope | Disposition and verification record |
| --- | --- |
| OpenCode pool and Claude history seam follow-up | [adapter-pool-history-followup](adapter-pool-history-followup.md) |
| Claude, OpenCode, and shared adapter test cleanup | [adapter_claude_opencode](adapter_claude_opencode.md) |
| Claude test-seam cleanup addendum | [adapter_claude_seams](adapter_claude_seams.md) |
| Codex adapter test cleanup | [adapter_codex](adapter_codex.md) |
| Grok adapter test cleanup | [adapter_grok](adapter_grok.md) |
| Completed API chat test cleanup | [api_chat](api_chat.md) |
| Completed cleanup: API workflow/config scope | [api_config_workflows](api_config_workflows.md) |
| API fold, roster, turns cleanup | [api_fold](api_fold.md) |
| Browser smoke cleanup | [browser-smoke](browser-smoke.md) |
| Agent-chat service and host supervisor cleanup | [daemon-chat-service-supervisor](daemon-chat-service-supervisor.md) |
| Daemon chat summary and routes cleanup | [daemon-chat-summary-routes](daemon-chat-summary-routes.md) |
| Runtime seam follow-up | [daemon-runtime-followup](daemon-runtime-followup.md) |
| Daemon accounts/files test cleanup | [daemon_accounts_files](daemon_accounts_files.md) |
| Daemon chat cleanup | [daemon_chat](daemon_chat.md) |
| Daemon runtime test cleanup | [daemon_runtime](daemon_runtime.md) |
| Checkpoint test cleanup | [host-checkpoints](host-checkpoints.md) |
| Host goal and deploy-hold test cleanup | [host-goals](host-goals.md) |
| Agent-host index test cleanup | [host-index](host-index.md) |
| Orchestrator test cleanup | [host-orchestrator](host-orchestrator.md) |
| Reconcile test cleanup | [host-reconcile](host-reconcile.md) |
| Host scheduling seam cleanup | [host-timer-seams](host-timer-seams.md) |
| Host ingestion and support cleanup | [host_ingestion_support](host_ingestion_support.md) |
| Completed cleanup record: host orchestration (owned subset) | [host_orchestration](host_orchestration.md) |
| Completed storage test cleanup (store scope) | [host_storage](host_storage.md) |
| Completed cleanup: MCP history, session views, session tools and joined output | [mcp-history-sessions](mcp-history-sessions.md) |
| MCP transcript cleanup | [mcp-transcript](mcp-transcript.md) |
| MCP test cleanup | [mcp](mcp.md) |
| UI thread-store dependency cleanup | [ui-thread-store-seams](ui-thread-store-seams.md) |
| Agent chat component test cleanup | [ui_chat_components](ui_chat_components.md) |
| Completed roster test cleanup | [ui_chat_roster](ui_chat_roster.md) |
| UI chat state test cleanup | [ui_chat_state](ui_chat_state.md) |
| Completed cleanup: agent-chat store, history and transport tests | [ui_chat_state_stores](ui_chat_state_stores.md) |
| Timeline test cleanup | [ui_chat_timeline](ui_chat_timeline.md) |
| Composer test cleanup | [ui_composer](ui_composer.md) |
| Shared UI test cleanup | [ui_general](ui_general.md) |
| Prompt-history test cleanup | [ui_general_prompt_history](ui_general_prompt_history.md) |
| Saved prompts test cleanup | [ui_general_saved_prompts](ui_general_saved_prompts.md) |
| UI workflows test cleanup | [ui_workflows](ui_workflows.md) |
| Workflow run and Steps test cleanup | [ui_workflows_runs](ui_workflows_runs.md) |
| Implemented workflow state test cleanup | [ui_workflows_state](ui_workflows_state.md) |
| Workflow daemon wiring seam cleanup addendum | [workflow-daemon-seams](workflow-daemon-seams.md) |
| Workflow engine cleanup disposition record | [workflow_engine](workflow_engine.md) |
| Workflow storage cleanup | [workflow_engine_storage](workflow_engine_storage.md) |
| Workflow execution cleanup | [workflow_execution](workflow_execution.md) |
| Process cleanup seam follow-up | [host-process-seams](host-process-seams.md) |
| Remote agent-chat retirement integration | [remote-agent-chat](remote-agent-chat.md) |
| Remote agent-host retirement integration | [remote-agent-host](remote-agent-host.md) |
| Remote daemon runtime retirement integration | [remote-daemon-runtime](remote-daemon-runtime.md) |
| Remote MCP retirement integration | [remote-mcp](remote-mcp.md) |
| Incoming Grok linking and retirement migration contracts | [remote-new-contracts](remote-new-contracts.md) |
| Remote shared package retirement integration | [remote-packages](remote-packages.md) |
| Remote workflow retirement integration | [remote-workflows](remote-workflows.md) |

The cleanup exposed a real full-item retrieval bug: a message outside the resident chat
window was discarded again when read from its durable log. The store now replays full
history for that read using the existing reducer, preserving multipart text and rewind
survival/exclusion. Two storage regressions replace the old comparison against the same
broken implementation. Normal chat-window retention is unchanged. Complete message replay
can use more transient memory for very long message histories; activity retention remains
bounded and event-loop yields are preserved.
See [storage](host_storage.md) for the exact failure and owner fix.

Removed support includes duplicated random/reference folds, fake SQLite indexes, unused
fixture builders, private projection and inventory exports, reset APIs, counters, wrappers,
and production options supplied only by tests. Retained regressions now use literal protocol
and storage expectations, actual filesystem/SQLite/process boundaries, and native timer
control. Factory dependencies used by real runtime composition remain. Generated protocol
bindings are unchanged; the manually authored catalog inventory test inside `_generated`
was deleted under the same test criteria.

Pre-merge validation passed. `pnpm check` passed every workspace, and
`pnpm build` passed including the desktop AppImage. Build warnings concern CommonJS
`import.meta`, bundle sizes, theme script bundling and packaging metadata/optional platforms;
none blocked the build. Both browser scenarios passed against the emitted web bundle and
left screenshots plus JSON results, as detailed in [browser smoke](browser-smoke.md).
The smoke surface used an isolated static server and synthetic unauthenticated transport;
it did not operate a deployed daemon or authenticated user session.

Desktop packaging rebuilt SQLite and PTY native modules for Electron. Their Node bindings
were restored before the repository test run. Preliminary integration runs caught
interrupted edits, a fixture pane-lifetime race, and a native mock-timer cleanup issue;
those were resolved in their owners. The final pre-merge `pnpm test` passed **5,987 tests**
(config 27, API 422, UI 1,258, daemon 4,280), with **zero failures, cancellations or skips**,
and all standalone checks passed. There is no coverage-threshold or test-count conflict. The repository defines no
separate lint script; its configured check gate is the workspace typecheck.
The final merge validation follows below.

The cleanup is **net −38,672 test/check lines** relative to incoming remote commit
`8dcbdc61` (6,942 added, 45,614 removed), excluding upstream retirement deletions
from the cleanup total. There are 413 remaining test/check files. The seven remote
reports cover incoming changes, including all 33 added or retitled named definitions;
retirement decisions explicitly supersede the original dispositions for obsolete tests.
A historical-record config regression preserves tab/head identity and resume data across
launcher retirement. New Grok linking tests use real account persistence and native
HTTP/timer boundaries; its unused auth/clock/sleep hooks are removed.

Merged `pnpm check` and `pnpm build` both passed. The build includes web assets and
the desktop AppImage, with the nonblocking warnings described above. The final
browser check passed both scenarios and left artifacts under
`/var/lib/orquester/tmp/orquester-smoke-oEvA33`. Node native modules were restored and verified
after packaging before the merged full test gate.

Final merged `pnpm test` passed **5,804 tests**: config 28, API 419, UI 1,257,
and daemon 4,100. There were **zero failures, cancellations or skips**, and every
standalone check passed. Final `git diff --check` and review of both merge parents
passed; no generated bindings, runtime state, credentials, build artifacts or dependency
changes were introduced by the cleanup. These final gates supersede all temporary
errors described in the scope reports during concurrent edits or merge resolution.

The original cleanup is
commit `89f36b03`; the merge containing this report incorporates remote `8dcbdc61`
and the audited incoming-test follow-ups. No required verification was skipped.
