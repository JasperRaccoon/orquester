# Agent host: storage, server, process support and session tools audit

Audited all 53 owned test files: 591 baseline runtime cases (577 source declarations; loop expansions retained as separate identities). Excludes adapters, orchestration and ingestion owned by other agents. Every runtime name, path, disposition and six-bar justification is in [host-other.json](host-other.json). Runtime identities come from the measured baseline reporter, not a name-pattern deletion rule.

Dispositions: CONSOLIDATE 4, DELETE 1, KEEP 454, OPTIMIZE 118, REWRITE 14. Three runtime executions disappear; no test file is removed. These counts include resource cleanup as OPTIMIZE and both removed and surviving consolidation identities.

Net test LOC is +15: resource teardown/isolation and stronger behavioral observations add slightly more lines than the three duplicate executions removed. No production behavior, production export, dependency, protocol fixture or snapshot changed in this scope. Existing fixtures/helpers still have callers; no orphan remained after the three removed executions. No test-only production seam was added.

## Evidence and retention

Each JSON row states the exact independently specified case, recognizable failure, independent assertion oracle, stable seam, refactor resistance and unique owner. The following sources and ownership distinctions apply in addition to that case-specific evidence. Literal fixture data may repeat arranged dependency inputs when the independently specified behavior is transport/persistence; those dependencies do not implement the transformation under test. Metamorphic code-stamp tests assert independently required determinism and graph inclusion, not a production-derived hash.

### boxes

Contract source: `docs/superpowers/specs/2026-10-19-ephemeral-ai-vms-design.md §7–8.5; apps/daemon/src/agent-host/README.md boxes module map`. Stable seam: BoxLaunch/AgentHostBoxes, ProviderChild, SDK SpawnedProcess, broker Unix socket, and real fixture-backed provider transports. Credible failures: Wrong launch location, wrong account/login, secret escape, missing bridge, lost reconnect output, or premature process completion. Uniqueness/non-test callers: Provider adapters and main.ts use these launch/transport APIs; launch configuration survives host handover. Pure parsing cases own normalization; integrated provider cases uniquely own actual box transport/config delivery.. Oracles are explicitly recorded per case; internal identifier renames and helper extraction do not affect those protocol/file/OS outputs.

### checkpoints

Contract source: `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §5.4–5.5; AGENTS.md repository preservation and secret redaction`. Stable seam: CheckpointService and GitRunner against temporary Git repositories/real child processes; documented persisted refs and NUL numstat format. Credible failures: Corrupting user Git state, publishing the wrong tree/ref/turn, losing a diff or falsely reporting a failed prune as successful. Uniqueness/non-test callers: orchestration/checkpoints-reactor.ts and server routes consume CheckpointService. GitRunner owns child failure/bounds; service owns actual Git state; baseline-dispatch alone owns before-provider ordering.. Oracles are explicitly recorded per case; internal identifier renames and helper extraction do not affect those protocol/file/OS outputs.

### index

Contract source: `docs/superpowers/specs/2026-09-23-thread-index-and-lazy-boot-design.md §C, invariants 1–8; apps/daemon/src/agent-host/README.md index map`. Stable seam: ThreadIndex observe/catchUp/read/stop API with actual SQLite, persisted reopen and a byte-positioned fixture log. Credible failures: Lost/duplicated history, invalid paging/search, accepting stale cursor/cache, exposing incomplete prompt results, or blocking shutdown. Uniqueness/non-test callers: main.ts opens/catches up/stops the index; orchestration/orchestrator.ts consumes these public methods. Indexer cases own derived rows and restart state; queries own externally consumed reads; lifecycle owns corruption/privacy and unavailable behavior.. Oracles are explicitly recorded per case; internal identifier renames and helper extraction do not affect those protocol/file/OS outputs.

### server

Contract source: `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §6.2–6.6 and §8; docs/superpowers/specs/2026-09-23-thread-index-and-lazy-boot-design.md §C; docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md §3/6; docs/superpowers/specs/2026-10-19-ephemeral-ai-vms-design.md §8.4`. Stable seam: Authenticated Unix-socket HTTP/NDJSON boundary, ordered live stream, real orchestrator, and actual index where appropriate. Credible failures: Wrong method/path/status/query normalization, auth bypass, reordered/lost stream frames, wrong per-stream targeting or unbounded backlog. Uniqueness/non-test callers: Daemon AgentHostClient/AgentHostSupervisor consume this protocol. Lower pure helpers do not prove socket dispatch, request parsing/status mapping or stream ordering/backpressure. Route cases asserting public Orchestrator options own transport normalization, not private method shape.. Oracles are explicitly recorded per case; internal identifier renames and helper extraction do not affect those protocol/file/OS outputs.

### session-tools

Contract source: `docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md §1.1–1.5 and §5; docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md §9.3–9.4, §12.1 and §14.1; apps/daemon/src/session-tools/README.md`. Stable seam: SessionToolsHost/credential/redactor API, real MCP client and loopback endpoint, daemon Unix socket and real ingestion/store/index. Credible failures: Wrong thread scope, usable revoked credential, ignored cancellation/denials, stale manifest winning a race, or a secret reaching durable/readable output. Uniqueness/non-test callers: Provider adapters consume grants/manifests and call results; main.ts constructs the service. Credential primitives retain entropy/header/revoke-listener semantics; endpoint cases own actual transport auth/cancellation; privacy integration owns every storage/read boundary and provider report shape.. Oracles are explicitly recorded per case; internal identifier renames and helper extraction do not affect those protocol/file/OS outputs.

### store

Contract source: `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §5.1, §6.3, §8; docs/superpowers/specs/2026-09-23-thread-index-and-lazy-boot-design.md A2/§C and invariant 1; docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md §2.2/§5; AGENTS.md append-only ordering, field-wise bindings and tolerant caches`. Stable seam: ThreadStore append/read/receipt/attachment/binding/snapshot API against private temporary files; documented id/path bytes. Credible failures: Persistent seq reuse, lost/duplicated output, trusting a stale cache, deleting referenced attachments, erasing resume identity, or allowing path escape. Uniqueness/non-test callers: main.ts/orchestration/server and index use ThreadStore. Schema tests do not prove writes/reopens/atomic ordering; fold tests do not prove file cursor validation or full-log reconstruction. Each corruption/race/reopen variant exercises the distinct failure named by its test.. Oracles are explicitly recorded per case; internal identifier renames and helper extraction do not affect those protocol/file/OS outputs.

### support

Contract source: `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §3.1, §4.1/4.5, §8–10; AGENTS.md environment isolation/process ownership; apps/daemon/src/agent-host/README.md support map`. Stable seam: Provider process/stdin/stdout/stderr/filesystem interfaces, documented input/output helpers and process signals; real OS process cases where needed. Credible failures: Credential/env leak, malformed NDJSON/UTF8, output loss, leaked or wrongly killed process, unbounded wait, or missed deploy code drift. Uniqueness/non-test callers: All four provider adapters, main.ts and agent-chat/supervisor.ts call these helpers. Fixtures isolate only OS dependencies; assertions inspect bytes, signals, externally required errors and live/dead state. Specialized PID-reuse/helper/session rules have distinct safety failures beyond generic process-group kill.. Oracles are explicitly recorded per case; internal identifier renames and helper extraction do not affect those protocol/file/OS outputs.

The real boot sweep and two-host teardown cases have their own composition-root evidence in the JSON: unit sweep/adapter/reconcile coverage cannot catch main.ts forgetting to perform or await an operation. The own-checkout code-stamp smoke is intentionally retained: injected fixture entries cannot catch an invalid default production entry path that silently disables deployment drift detection. The frozen legacy catalog hash is an independently captured compatibility byte contract (unified MCP §14.1), rather than an export inventory.

## Implemented decisions

- Deleted the codeStampsDiffer truth table because the supervisor already drives every same/different/unknown adoption and restart case through its public lifecycle.
- Consolidated primitive relaunch credential revocation into real endpoint 401 coverage; the surviving endpoint also verifies another thread remains authorized.
- Consolidated capture failure and home-path redaction into one real Git failure scenario. A real reference-transaction hook prints its absolute working directory and refuses the ref even as root. Ref-survival pruning now uses a genuine competing Git lock and batch-seeded refs. All error/privacy/survival assertions remain.
- Replaced the private final-drain spy with real ingestion/redaction and durable output through orchestrator stop. The retained lower ingestion final-drain test owns flushing semantics; this case uniquely proves host propagation.
- Replaced error-copy assertions with stable error codes, command status probes with actual recorded/read-back effects, empty leases with a real provider-start lifecycle and prepared-dir fixture, and a production-derived on-demand expectation with fixed expected live/settled agents.
- Removed incidental launch.json whitespace matching; the persisted boxId and fail-closed unreadable box behavior remain.
- Cleaned owned temporary directories in store and box fixtures; size-only image cap fixtures use sparse files. Codex/Grok/OpenCode box tests now keep temporary config under their own appdir rather than sharing /tmp, and OpenCode teardown awaits stopAll.

## Baseline and performance limits

Baseline uses Node 24.22.1, pnpm 10.12.1, the default four test-file workers, TSX_DISABLE_CACHE=1, and real native modules on this host. Overall baseline/final suite timing and test gates are coordinated by the parent report. Baseline own cases include three checkpoint fixture failures: root bypasses chmod(0500), so the expected Git failure never occurred; the failure regression and privacy contract are retained with a deterministic real Git rejecting hook and competing ref lock. Codex/Grok box baseline launches additionally lacked node on their sanitized /usr/bin:/bin PATH; the parent fixes that environment prerequisite.

The slowest own baseline cases are:

- `support/lifeline.test.ts` — a group that ignores SIGTERM is SIGKILLed after the grace: 5235.924 ms.
- `host-teardown.test.ts` — an authenticated host stop reaps a helper that ignores SIGTERM before reporting completion: 1536.727 ms.
- `host-teardown.test.ts` — an intentional stop's running Codex turn is continued by the next host, the teardown's rows kept: 749.163 ms.
- `host-teardown.test.ts` — a host teardown waits for every Grok session's stop: its helpers swept, the left-running row and the stop in the log, its work left running: 740.255 ms.
- `host-teardown.test.ts` — an intentional stop's running Grok turn is continued by the next host, the teardown's rows kept: 673.123 ms.
- `checkpoints/git.test.ts` — a transient lock failure is retried, and only when the caller asked: 592.858 ms.
- `checkpoints/service.test.ts` — E2E #E8: a capture for a turn a revert truncated is dropped: 585.279 ms.
- `support/leftover-processes.test.ts` — the real /proc: a recorded session's members are stopped, a daemon and a stranger spared: 460.265 ms.

The 5.236 s lifeline case intentionally keeps its real 5 s TERM-to-KILL grace: a real shell watcher must kill a SIGTERM-resistant group after host death, not before the grace or indefinitely later. Existing fake clocks cover the in-process signal policies; adding a test-only production shell clock would weaken this integration boundary. Real host teardown/handover cases retain process exit, durable log and next-host assertions.

The hypothesized SQLite default-busy-timeout bottleneck was disproven by measurement (25.010 ms and 21.039 ms); its driver configuration was left alone. The process-group case measured 38.945 ms and was not rewritten merely because it contains a bounded OS-state polling loop. No claim of a measured speedup is made from removed setup operations or sparse fixture size alone.

## Validation

Pending coordinated focused run, affected package typecheck and parent full gate. Exact per-file commands are recorded in the JSON; no test run was started while another worktree run owned the test slot. The first coordinated check:changed run passed the other owned changed cases but exposed two faulty rewritten fixtures: a blocked ref namespace produced only a relative-path Git error (no home path to redact), and a newly created profile thread correctly had no live provider lease. The fixture now uses a genuine rejecting Git hook that prints its absolute working directory, and the lease case starts the provider through HTTP before expecting a lease. Focused rerun remains pending the coordinator slot.
