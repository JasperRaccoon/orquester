# Current test cleanup

This is the implementation record for the cleanup starting at `9675e82284b10d4cc360535bcf58d0776ce20990`. The older reports linked below the current pointer in README describe an earlier cleanup and are not this run's validation evidence.

The starting inventory contains **450 test/check files** (438 test files and 12 standalone checks), **6,097 named test definitions**, and 149,286 test/check lines. Parameterized declarations count once; runtime test totals differ. The two existing deployment-smoke scenarios were also reviewed. Twenty parallel scope owners read tests and production owners, recorded dispositions before editing, and implemented the cleanup. Root reviewed integration, remaining support, and production diffs.

All original paths and named definitions reconcile to the reports below: **zero missing paths or names**. Each report records DELETE, REWRITE, or KEEP for its original cases. Per-case decisions and their shared owning-contract records supply the six behavioral bars: independent source, recognizable failure, independent oracle, stable seam, refactor tolerance, and lowest distinct owner. They also record stronger remaining coverage, production callers, removal risk, and validation. Follow-up decisions in a report supersede its earlier recorded decisions.

The cleanup removes **10,458 net test/check lines** (2,045 added, 12,503 removed), and **11,560 net source/test/support lines** excluding Markdown. Eight test/check files are removed entirely. Counts describe the result, not a deletion target. No coverage threshold or test-count constraint justified retention.

## Dispositions by scope

| Scope record | Coverage |
| --- | --- |
| [agent-profile](agent-profile.md) | Daemon agent profiles and CLI configuration |
| [api-chat](api-chat.md) | Shared chat wire/runtime contracts |
| [api-config](api-config.md) | API workflows, prompt contracts, persisted config |
| [daemon-accounts-usage](daemon-accounts-usage.md) | Accounts, managed homes, usage and registry |
| [daemon-core](daemon-core.md) | Core daemon services, routes, filesystem, git, process ownership and browser-smoke retention |
| [host-codex](host-codex.md) | Codex provider adapter |
| [host-goals-current](host-goals-current.md) | Goal lifecycle and deploy hold |
| [host-grok](host-grok.md) | Grok provider adapter |
| [host-ingestion](host-ingestion.md) | Provider ingestion and event folding |
| [host-opencode](host-opencode.md) | OpenCode provider adapter |
| [host-orchestration](host-orchestration.md) | Agent host orchestration |
| [host-other-adapters](host-other-adapters.md) | Claude and shared adapter contracts |
| [host-runtime-chat](host-runtime-chat.md) | Chat service, host transport and shutdown |
| [host-storage](host-storage.md) | Durable event log, attachments and SQLite indexes |
| [mcp-current](mcp-current.md) | MCP tools and protocol |
| [mcp-messages-current](mcp-messages-current.md) | MCP message delivery and responses |
| [mcp-workflows-current](mcp-workflows-current.md) | MCP workflow tools |
| [ui-chat-components](ui-chat-components.md) | Chat component behavior and retained render checks |
| [ui-chat-history-current](ui-chat-history-current.md) | History normalization and chat history store |
| [ui-chat-lib](ui-chat-lib.md) | Chat state, transport and presentation behavior |
| [ui-composer](ui-composer.md) | Composer input, queue, send and file contracts |
| [ui-other](ui-other.md) | Shared UI state, profiles, configuration and miscellaneous checks |
| [ui-workflows](ui-workflows.md) | Workflow UI and state |
| [workflows-agent](workflows-agent.md) | Workflow agent/session execution |
| [workflows-engine](workflows-engine.md) | Workflow graph execution, persistence and secrets |

## Removed support and production seams

Removed support includes five unused Claude raw captures, a 184-line MCP workflow behavior fake, redundant host/session fixtures, render-only state builders, obsolete imports and test collectors. Fixture provenance remains documented in the provider README.

Removed production seams include profile width/initial-state/error-render injection props; browser storage overrides; saved-prompt clock injection; configurable Escape double-press timing; timeline cache inspection/persistence methods; OpenCode recycle drains and their bookkeeping; unused sync workflow rule evaluators; workflow environment/limit/id factory hooks; unused redaction/cost/conversion helpers; session clear/open-stream accessors; and unused helper/type exports. The scope reports list exact symbols and caller searches. Actual production composition dependencies remain. Generated bindings, package dependencies, credentials and runtime state are unchanged.

Independent review of the complete production diff found no concrete behavior regression. Production edits remove unused access paths and preserve their former defaults. No product behavior was changed to rescue a test.

## Verification

Scoped test runs and relevant typechecks are recorded in each report. The attempted initial whole-repository baseline run was not a clean baseline: locked dependencies were absent and concurrent cleanup had begun. `pnpm install --frozen-lockfile` restored the existing lockfile's dependencies without manifest or lockfile changes. No baseline passing claim is made for that run.

Two retained timing cases exposed harness problems under load. The assertion regression now waits for the child process to finish imports before measuring the same ten-second assertion budget. Host teardown observes authenticated stop completion and actual helper disappearance; the adapter lifecycle test owns the exact TERM-to-KILL grace. The previous in-process elapsed-time check never exercised the process entry point's three-second SIGTERM backstop. The Grok timer driver now advances the specific grace timer instead of unrelated timers. These changes retain the failure oracles without measuring unrelated startup or filesystem scheduling.

`pnpm check` passed every workspace before remote integration. The original-scope full `pnpm test` is still running; final repository validation is recorded here after completion. There is no separate repository lint script; `pnpm check` is the configured typecheck gate. Required commands are `pnpm check`, `pnpm test`, and `pnpm build`, plus the existing browser smoke and final diff review. CPU affinity limits worker pressure without altering scripts or test counts.
