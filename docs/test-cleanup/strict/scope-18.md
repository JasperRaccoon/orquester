# Scope 18 — strict workflow engine, storage and route cleanup

Completed cleanup with an implementation ledger recorded before test/production edits. Scope: all 178 original cases in the 16 assigned files. Original names are preserved below even when a retained test is narrowed.

Independent source: [workflow requirements](../../superpowers/specs/2026-09-28-automated-workflows-design.md), checked against current shared wire types and daemon contracts. Storage/security regression cases additionally enforce AGENTS.md. Implementation comments alone were not used to justify private-shape assertions.

For each KEEP/REWRITE, the row provides the concrete independent behavior, recognizable failure and fixed expected outcome (bars 1–3). Its owner rationale below supplies the exact requirement/seam/callers (bars 1 and 4), refactor tolerance (bar 5), and distinct lowest owner/no stronger duplicate (bar 6). These common parts apply only together with that row’s concrete oracle.

All retained assertions observe public wire responses/events, documented component return values, external side effects, durable persisted records, or explicitly defined executor/clock/store interfaces. Internal function names/order/layout can change without changing those observations. Mocks implement external providers, never the retained routing/redaction/storage decision. Controlled deferred operations/clock ticks expose race states without sleeps.

## Owner rationale and risk

- **engine**: §§3.2–3.4, 4, 5.8–5.11, 7.6 and contracts.ts WorkflowEngine/TriggerHost/NodeExecutionContext. Actual production routes, schedulers, poller and factory call this seam. Node executors supply outcomes, not the engine decisions asserted; no lower component owns admission, graph execution, retries, persisted handover or cross-run cleanup. Risk: security/data-loss or protocol regression if the stated output changes; fixture IDs/times/data are authored independently, never recomputed by the function under test. Refactoring behind the named seam preserves every retained oracle.
- **route**: §8.1 plus packages/api/src/workflows/{types,expression-preview}.ts request/response contracts and AGENTS.md secret non-disclosure. Shared API client/MCP/GUI call these URLs; tests inject the real Fastify routes and real stores. Standalone parser/store tests cannot detect route guards, ownership, wire serialization or selection of preview run/context. Risk: security/data-loss or protocol regression if the stated output changes; fixture IDs/times/data are authored independently, never recomputed by the function under test. Refactoring behind the named seam preserves every retained oracle.
- **store**: §§3.1, 5.7–5.8, AGENTS.md tolerant persistence/host-only secrets, and contracts.ts store interfaces. Production factory, engine, service/routes, scheduler/poller and sweepers call these stores. Real temporary filesystem/reopening is the lowest durable seam; schema-only tests do not cover disk recovery, permissions, ordering or retention. Risk: security/data-loss or protocol regression if the stated output changes; fixture IDs/times/data are authored independently, never recomputed by the function under test. Refactoring behind the named seam preserves every retained oracle.
- **e2e**: §§2, 5.8, 6, 8.1–8.3: critical automation authoring/run/restart workflows through production createWorkflowDaemon, real routes and persistent stores. Daemon startDaemon is the non-test caller. Artifact: daemon-harness preserves results.json containing persisted runs and workflow events under a printed orq-workflow-evidence directory. Lower owner tests do not exercise actual module wiring; E2E keeps only distinct integration failure modes. Risk: security/data-loss or protocol regression if the stated output changes; fixture IDs/times/data are authored independently, never recomputed by the function under test. Refactoring behind the named seam preserves every retained oracle.
- **services**: §§3.4, 5.3, 5.9–5.11 and contracts.ts ProjectOps/WorkflowNotifier. Production factory/engine/sweepers use these stable interfaces. Fixed resource outcomes, HTTP wire requests, filesystem containment or emitted notifications are observed; collaborators supply external facts and do not implement the decision under test. Risk: security/data-loss or protocol regression if the stated output changes; fixture IDs/times/data are authored independently, never recomputed by the function under test. Refactoring behind the named seam preserves every retained oracle.
- **summary**: §§7.1, 8.1; packages/api/src/workflows/types.ts WorkflowSummary and AGENTS.md client-visible state. Production routes and daemon-wiring use buildWorkflowSummary. Notification projection/catalog invalidation is owned here, distinct from lower validator correctness and higher bus subscriptions. Risk: security/data-loss or protocol regression if the stated output changes; fixture IDs/times/data are authored independently, never recomputed by the function under test. Refactoring behind the named seam preserves every retained oracle.

## Per-case disposition

### `apps/daemon/src/workflows/catalog-events.test.ts`

Owner rationale: **e2e**. Focused command: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test --test-concurrency=2 src/workflows/catalog-events.test.ts` (from apps/daemon).

- **REWRITE** `a provider change re-judges the rows: the problem goes out, and comes back, without an edit` — Registry change could leave a stale rail error: unknown_model appears, disappears when the model arrives, and returns with config.chain.0.model when removed. Change: Remove exact diagnostic-copy assertion; retain error code, field, transitions and event publication.

### `apps/daemon/src/workflows/e2e-agent.test.ts`

Owner rationale: **e2e**. Focused command: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test --test-concurrency=2 src/workflows/e2e-agent.test.ts` (from apps/daemon).

- **KEEP** `a restart while the agent works resumes the watcher and never sends the turn twice` — A restart could submit the same agent task twice: one persisted watching run resumes to the entire answer on attempt 1 with exactly one turn/session.
- **KEEP** `an agent prompt and its chat title read {{ workflow.… }} as every other block does` — The live engine could omit workflow identity from agent templates: the sent prompt and chat title must contain the authored workflow name/ID without missing-reference warnings.

### `apps/daemon/src/workflows/e2e-mcp.test.ts`

Owner rationale: **e2e**. Focused command: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test --test-concurrency=2 src/workflows/e2e-mcp.test.ts` (from apps/daemon).

- **REWRITE** `the published Jira create and edit example stays valid on the real routes` — Published Jira authoring commands could fail against actual write routes: create/edit both have zero errors, remain disabled, and edit reaches revision 1. Change: Execute the published authoring guide JSON commands obtained through MCP rather than internal fixture exports; remove JIRA_FIXER_EXAMPLE/JIRA_FIXER_EDIT_OPS exports.
- **DELETE** `list_workflow_block_types returns every config schema and both whole guides within the result budget` — Guide equality is an assertion against imported production prose, plus a private budget subtraction; no independent oracle. MCP result-budget tests own truncation and API catalogue/schema tests own config contracts.
- **DELETE** `list_workflow_block_types {type} returns that block's full contract: schema and guide sections` — Echoes WORKFLOW_BLOCK_GUIDES.code through JSON serialization and inventories guide presence. API catalogue/schema contracts and MCP tool routing survive without this prose inventory.
- **DELETE** `every published recipe creates on the real routes with zero errors` — Duplicates API guide.test.ts executable recipe build/validation through an extra daemon/MCP layer; it checks only zero validation errors.
- **DELETE** `a code block gets exactly the documented arguments, environment and result rules` — Argument/env export inventory derives its oracle from WORKFLOW_CODE_ARGUMENT_NAMES and WORKFLOW_SANDBOX_ENV_NAMES. Sandbox SDK execution owns actual arguments, globals, return/throw/stop/env contracts; engine.test.ts owns stopping downstream; retained MCP run/output round trip owns wiring.
- **KEEP** `validate_workflow: a draft with the placeholders the tool fills in validates on the real route` — MCP draft normalization could produce invalid requests: complete and minimal drafts validate; shell-script interpolation is rejected as shell_template.
- **KEEP** `run_workflow waits for a real run and its stored output can be read by node name` — MCP wait/output name addressing could fail: input 21 produces stored doubled=42, one history run, and name-based output retrieval returns that value.
- **DELETE** `preview_expression renders templates against a real run, from a block's point of view` — Replays route preview expression, source selection and redaction scenarios through MCP. routes.test.ts owns preview context/security, while MCP workflows.test.ts owns argument/envelope mapping.

### `apps/daemon/src/workflows/e2e.test.ts`

Owner rationale: **e2e**. Focused command: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test --test-concurrency=2 src/workflows/e2e.test.ts` (from apps/daemon).

- **KEEP** `every block's status, output, handle and edge; the run persisted; secrets redacted everywhere` — Real daemon wiring could leak a secret or lose pipeline data: code→shell→HTTP produces the fixed greeting/request/output, persisted successful run, redacted events/log responses and removed secret input file.
- **KEEP** `the runtime stops while a shell block sleeps; a new one over the same appdir resumes it` — Shutdown could kill or re-execute a detached shell: the PID survives, a file event releases it, the new runtime completes attempt 1 and downstream reads slept.
- **KEEP** `nextRunAt reaches the rail, the scheduler fires the run on time, the next time follows` — Scheduler-to-engine/event wiring could fail: 12:05 scheduled payload creates a successful stored run, rail nextRunAt advances to 12:10 and state records 12:05.
- **KEEP** `the poller baselines, fires once on a push, and a failing poll shows on the rail` — Poller-to-engine/event wiring could fail: baseline fires nothing, changed SHA yields a stored push result, authentication failure reaches rail lastError without another run.

### `apps/daemon/src/workflows/engine-fixes.test.ts`

Owner rationale: **engine**. Focused command: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test --test-concurrency=2 src/workflows/engine-fixes.test.ts` (from apps/daemon).

- **KEEP** `an HTTP POST reached after stop() is not sent; the resumed run sends it exactly once` — Stopped engine could issue an unrecorded POST: paused project resolution releases after shutdown, sends nothing, and resumed engine sends once.
- **KEEP** `a runner spawned while the engine stopped is adopted from its handle, never spawned twice` — Shutdown during spawn could duplicate side effects: durable pre-spawn marker causes adoption of one existing process and completion output 7.
- **KEEP** `a parent's secret rendered into a sub-workflow's input is redacted in the child run` — Child input could persist a parent-scoped secret: child trigger payload and all published records contain its placeholder, never the original value.
- **KEEP** `a code runner stopped from outside fails the block; the run does not succeed` — External process cancellation could be reported successful: SIGTERM/cancelled exit produces failed run with interrupted block.
- **KEEP** `a block that answers cancelled while nothing cancelled the run fails it` — Unexpected executor cancellation could silently skip work as success: run fails and downstream never executes.
- **KEEP** `a missing existing project fails the run with errorKind project_missing` — Missing project could lose its structured failure: result and run history carry project_missing.
- **KEEP** `a restart during the creation: the pending path is on disk, removed, and made again` — Crash during project creation could leak a directory: pending path is durable, removed before recreation, then marked deleted after success.
- **KEEP** `a failed creation removes what it left and records nothing pending` — Failed clone could leave a pending directory forever: cleanup removes its recorded path and stores deleted=true.
- **KEEP** `a run whose saved state cannot be read is due for the sweeper` — Unreadable saved workflow could orphan temp projects: resumed run becomes interrupted and its project receives deleteAfter.
- **KEEP** `stopping during the finalize's delete leaves the project due for the sweeper` — Shutdown awaiting cleanup could lose the only sweep deadline: persisted successful run retains undeleted temp project due for sweeping.
- **KEEP** `a release event clones at its tag; a PR head the clone cannot resolve is retried at the PR branch` — Git event clone could checkout the wrong revision: release uses v1.2.0; unavailable PR SHA retries feature/x once and succeeds.
- **KEEP** `a run is not active until its record exists; a failed create leaves nothing active` — Failed first persistence could leave a phantom active run: admission rejects and active IDs stay empty before/after disk failure.
- **KEEP** `a stored run naming a block `__proto__` is interrupted, never walked` — Legacy prototype block ID could pollute or run: persisted malicious record is interrupted and Object.prototype has no status.
- **KEEP** `an invalid URL quoting a long secret is redacted before it is cut` — Truncating before redaction could leak a secret prefix: invalid URL error is validation, includes the placeholder, and contains no repeated secret bytes.

### `apps/daemon/src/workflows/engine-resume.test.ts`

Owner rationale: **engine**. Focused command: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test --test-concurrency=2 src/workflows/engine-resume.test.ts` (from apps/daemon).

- **KEEP** `a Wait block's timer resumes at the same wall-clock instant` — Restart could extend a wait: original 10:10 wall-clock deadline holds despite four minutes downtime; downstream executes once.
- **KEEP** `a retry delay resumes, then the next attempt runs` — Restart could reset retry count: persisted delay resumes and success is attempt/output 2.
- **KEEP** `a code process that ended while the daemon was down: its exit.json is read` — Completed child process could be ignored after restart: exit record yields exception with authored thrown/stack fields.
- **KEEP** `a process gone without a record is interrupted — retried when the policy allows` — Lost process could hang or repeat without policy: no retry fails interrupted; configured retry spawns once more and completes attempt 2.
- **KEEP** `a child run is re-subscribed by its parent` — Parent could lose its child subscription: persisted child wait resumes, final input/output flows and After executes once.
- **KEEP** `an HTTP GET is re-issued; a POST fails interrupted` — Restart could repeat non-idempotent HTTP: GET reissues and returns body; POST fails interrupted without a request.
- **KEEP** `a block running without a WaitingOn: a pure block re-runs as the same attempt` — Pure block could be marked interrupted or spend a retry: same attempt reruns IF, retains prior A and executes B.
- **KEEP** `a side-effecting block running without a WaitingOn is interrupted (no retry)` — Side-effecting work with no durable wait marker could repeat: A fails interrupted, error edge runs B, overall recovery succeeds.
- **KEEP** `queued runs start after a restart; a run whose definition cannot be read is marked interrupted` — Boot could strand queued runs or crash on malformed neighbors: queued run succeeds while unreadable record becomes interrupted.
- **KEEP** `stop() persists the last state and writes nothing after` — Old engine could overwrite successor state: stop persists last activity, later completion writes/events cease and new runs are refused.

### `apps/daemon/src/workflows/engine.test.ts`

Owner rationale: **engine**. Focused command: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test --test-concurrency=2 src/workflows/engine.test.ts` (from apps/daemon).

- **KEEP** `IF takes one branch; the other is skipped with its edges dead` — Wrong handle/dead-path propagation would run the unchosen branch: true/false runs select Yes/No, skip dead descendants and preserve trigger input.
- **KEEP** `Switch: the first matching case wins, the fallback takes the rest, no fallback kills every edge` — Switch no-match could incorrectly succeed down a branch: case:1, default and no-fallback outcomes select the fixed blocks or skip all.
- **KEEP** `independent branches run concurrently; Merge (all) waits for every live input` — Merge could run early or serialize independent work: both inputs start; after A only merge stays pending; A+B yields {A:a,B:b}.
- **KEEP** `Merge (first) runs on the first arrival and ignores the later one` — First-arrival merge could rerun: B arrival produces {B:b}, After runs once and later A cannot replace output.
- **KEEP** `a block with several live inputs and no Merge reads the merge object` — Multiple direct inputs could be silently dropped: downstream context contains both named A and B keys.
- **KEEP** `a failure with an error edge routes down it and the run succeeds` — Handled failure could fail the run or lose partial data: error edge receives partial output and error metadata while success branch skips.
- **KEEP** `a failure without an error edge fails the run and cancels the running siblings` — Unhandled failure could leave sibling side effects running: run fails, sibling signal aborts and downstream is cancelled.
- **KEEP** `retries wait their delay on a persisted timer, then succeed` — Retry delay could be skipped or attempts/error stale: waits at +30s, succeeds on attempt 3 and clears old error.
- **KEEP** `all_burnt and limit_exceeded failures are never retried` — Permanent failures could waste retries: all_burnt and limit_exceeded each execute once despite a three-attempt policy.
- **KEEP** `an agent waiting for a usage reset (kind agent, phase waiting-reset) reads waiting and resumes as such` — Usage-reset wait could look active: persisted agent waiting-reset reports waiting/until; resumed watch clears until and completes.
- **KEEP** `retries exhausted: the last failure stands` — Retry exhaustion could loop forever or lose failure: two attempts then failed run.
- **KEEP** `a disabled block passes its input through as success without running` — Disabled block could execute a side effect: only B executes and A forwards manual input as succeeded.
- **KEEP** `Stop as failure fails the run with its message and value` — Failure Stop could be counted as success: failed status/message/value are returned and sibling cancels.
- **KEEP** `code's stop() ends the run as stopped` — Successful code stop could keep executing downstream: result is stopped with its reason and downstream cancels.
- **KEEP** `a trigger-less workflow starts at its roots with the manual input` — Triggerless workflow could never start or read wrapper input: roots execute A then B and A receives raw manual input.
- **KEEP** `a fired trigger runs; the others are skipped` — A scheduled fire could also execute manual branch: only scheduled A executes, other trigger/branch skip and event payload survives.
- **KEEP** `a run with validation errors is refused (manual) or recorded as failed (trigger)` — Invalid definitions could run or lose scheduled history: manual refuses INVALID_WORKFLOW; automated fire records a failed stub; absent ID refuses.
- **KEEP** `a projectOverride block runs in that project; a missing one fails the block` — Project override could be ignored: executor sees the other existing project, then reports project_missing after removal.
- **KEEP** `an executor that throws or answers nonsense fails its block as internal` — Broken executors could crash the host or hang: thrown error and unknown result both produce internal block errors.
- **KEEP** `a big output goes to a file with an inline preview; downstream and nodeOutput read it whole` — Large output could be truncated for downstream: preview <=64 KiB exposes no host path while downstream/nodeOutput get the whole 100k object.
- **KEEP** `an output over the hard cap fails the block with limit_exceeded` — Oversized output could exhaust storage: >16MiB JSON becomes limit_exceeded and failed run.
- **KEEP** `a secret appearing in an output, an error or a warning is redacted everywhere` — Engine might redact only displays: output/error/warnings, downstream values, stored runs and events all exclude the real secret.
- **REWRITE** `the per-run update events are throttled; the final state is always published` — Event throttling could lose last state: burst coalesces within 250ms, final activity/status are published before finished. Change: Remove unrelated last-event type assertion; retain <=4/s throttle, latest delta, final state and update-before-finished protocol ordering.
- **KEEP** `cancel mid-block aborts it and ends the run cancelled` — Cancel could complete twice or run descendants: one accepted cancel yields cancelled blocks/run and subsequent cancel returns false.
- **KEEP** `a block that ignores its abort cannot hold a cancelled run forever` — Uncooperative executor could prevent cancellation forever: grace expiration still finalizes the run and its block cancelled.
- **KEEP** `the run timeout fails the run and cancels what runs` — Run timeout could be reset/ignored: run stays active at 119s then fails at 120s and cancels active work.
- **KEEP** `skip: a second fire records a skipped stub; force runs anyway` — Overlap skip could run two jobs: second records skipped/overlap; explicit force starts another.
- **KEEP** `queue: one pending fire waits for the active run; a further fire is skipped` — Queue could grow without bound or never drain: one pending waits, third skips, then queued run starts after first completion.
- **KEEP** `parallel: up to maxConcurrent, then skipped` — Parallel policy could ignore maxConcurrent: exactly two active starts and third overlaps.
- **KEEP** `the global run cap queues runs beyond it, FIFO` — Global admission could exceed four or reorder queue: first four execute, e starts on release before f.
- **KEEP** `a queued run can be cancelled before it starts` — Cancelling queued work could start it: run ends cancelled without startedAt.
- **KEEP** `agent blocks and sandbox processes wait behind their global caps` — Block resource limits could be bypassed: fifth agent/ninth process queue until release and then finish.
- **KEEP** `an agent block's timer wait releases its slot; waking takes it back` — Waiting agent could starve other jobs: timer wait releases its slot, queued fifth starts, waking reacquires before returning running.
- **KEEP** `usePinned: a pinned block is not executed and downstream reads its pin` — Pinned testing could run a real block: A never executes, carries its pin and B reads the pin in a test run.
- **KEEP** `without usePinned, pins are ignored` — Normal runs could reuse a stale pin: A actually executes without usePinned.
- **KEEP** `fromNodeId runs that block and its downstream; upstream from pins, else the latest run` — Partial run could seed wrong history/pins: only B/C execute, X pin wins and A comes from recorded run; unknown origin refuses.
- **KEEP** `testNode executes only that block, even with no upstream data` — Single-block test could execute neighbors: only B runs with null input, A/C remain skipped.
- **KEEP** `testNode seeds only the tested block's upstream: downstream and side branches stay skipped` — Single-block test could misrepresent stale descendants: only upstream A seeds, downstream C/side S remain skipped with no output/live edges.
- **KEEP** `retryOf reuses the succeeded blocks and re-runs the failed ones` — Retry could repeat successful side effects: A is reused, B/C rerun and original trigger payload stays.
- **KEEP** `retryOf + fromNodeId on the fired trigger re-runs everything with the same event` — Retry from trigger could accidentally seed successes: A/B rerun from the original git SHA while manual branch remains skipped.
- **KEEP** `retryOf + a non-trigger fromNodeId runs from there on that run's upstream outputs` — Run-from-here could choose newer history: B reads a1 from the explicitly retried run, not later a2.
- **KEEP** `retryOf does not reuse a success that sits below a block being re-run` — Retry could carry stale error-handler output: changed A success skips former E error branch and executes B.
- **KEEP** `created per run, deleted when the run succeeds` — Success could leak a temporary project: per-run clone path is recorded and removed; repeated delete reports already absent.
- **KEEP** `kept keepFailedTempDays when the run fails; Delete now removes it` — Failure cleanup could discard diagnostics: failed project retained three days, explicit Delete now removes and persists it.
- **KEEP** `a git trigger on the project repo clones at the event's sha` — Push-created checkout could use latest branch instead of event: clone ref is fixed abc123 SHA.
- **KEEP** `the child's final output is the block's output; runs are linked both ways` — Subworkflow could lose output/linkage: child receives 21, returns doubled=42 and parent/child IDs connect both ways.
- **KEEP** `a failing child fails the block with child_run_failed` — Child failure could be treated successful: parent block gets child_run_failed containing inner error.
- **KEEP** `the depth limit and cycles are refused at run time` — Nested workflows could loop or exceed limits: sixth level fails limit_exceeded; x→y→x cycle refuses validation.
- **KEEP** `cancelling the parent cancels the child` — Parent cancel could leave child running: both parent and child become cancelled.
- **KEEP** `child runs bypass the global run cap (no deadlock)` — Parent-held global slots could deadlock children: five nested workflows complete despite four-run global cap.
- **KEEP** `deleting a workflow cancels its runs and stops writing them` — Deleted workflow could resurrect late state: active run cancels, late completion cannot restore run data or notify.
- **KEEP** `enabledTriggers lists enabled workflows' live trigger nodes; definition changes are forwarded` — Disabled triggers could still arm: only enabled S1 enumerates; changed/deleted subscription fires until unsubscribed.
- **KEEP** `recordSkipped writes a visible stub` — Missed schedule could vanish from history: recordSkipped exposes skipped/missed trigger stub and a finished event.

### `apps/daemon/src/workflows/integration.test.ts`

Owner rationale: **summary**. Focused command: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test --test-concurrency=2 src/workflows/integration.test.ts` (from apps/daemon).

- **DELETE** `a throw fails the block with its message and stack; stop() stops the run` — Repeats real sandbox throw/stop/deadline cases, engine stopped-result handling, and engine-resume exception mapping through an extra layer. Retained sandbox SDK tests, engine stop/failure cases and resume exit-record test cover independent owners.
- **KEEP** `a shell block gets its env (secrets included), never a rendered script; exit codes map` — Shell interpolation could execute data or misclassify nonzero exits: literal shell metacharacters remain stdout, secrets redact, exit 3 preserves partial output and fails.
- **KEEP** `cancelling a run kills its shell promptly` — Engine cancellation could fail to reach the real process: ready PID no longer exists after cancelled completion.
- **KEEP** `JSON responses are parsed; query and headers are rendered (secrets allowed, redacted after)` — HTTP rendering/transport could corrupt values: encoded a b&c query returns unchanged, Authorization carries real secret to server, JSON body parses.
- **KEEP** `text stays text; redirects are followed or not; statuses map` — HTTP response mapping could ignore redirect/status settings: text preserved; redirects follow/stop as configured; 404 fails unless explicitly accepted.
- **KEEP** `bodies: JSON rendered from a value, form fields, text` — HTTP body encoding could be wrong: object JSON, rendered JSON, URL-encoded form and custom text have fixed wire bodies/types; malformed rendered JSON fails expression.
- **KEEP** `the body cap, the timeout and a network error each fail the block with their kind` — HTTP failures could collapse into the wrong kind: 32MiB cap, stalled server, closed port and rendered ftp URL yield limit_exceeded/timeout/network/validation.

### `apps/daemon/src/workflows/routes.test.ts`

Owner rationale: **route**. Focused command: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test --test-concurrency=2 src/workflows/routes.test.ts` (from apps/daemon).

- **KEEP** `without the engine: acting routes answer 503 ENGINE_UNAVAILABLE` — Unavailable engine could yield 500 or attempt work: run/test/cancel/delete-temp/account preview each return 503 ENGINE_UNAVAILABLE.
- **KEEP** `without the engine: history, run detail and outputs are read from the run store` — History could fail during boot without engine: real stored runs page by ID; detail strips private data; whole output remains readable; missing resources refuse.
- **REWRITE** `definitions: create, read, replace (409 on a stale revision), patch, duplicate, validate` — Validation route could omit saved-prompt catalog: missing saved prompt yields unknown_saved_prompt; malformed request and missing workflow have typed errors. Change: Remove duplicate CRUD/revision/enable/duplicate scenarios owned by service.test.ts; retain route validation context for saved-prompt IDs and malformed/missing-resource wire errors. Final retained title: `validate uses the daemon's saved-prompt catalog and reports malformed or missing resources`.
- **KEEP** `the list filters by project: the existing project, plus temp workflows of its workspace` — Project filter could expose irrelevant workflows: existing project plus same-workspace temporary workflow are the only listed IDs.
- **KEEP** `block types and the schedule preview` — Schedule preview could ignore requested counts or invalid input: count=3 gives three, excessive count caps at 20, invalid cron has valid=false and no runs.
- **KEEP** `secrets: names only, write-only values, scoped to an existing workflow` — Secret route could expose values or accept nonexistent workflow scope: names/scopes only, value omissions/bad names reject and global delete preserves scoped value.
- **KEEP** `delete cascades: active runs cancelled through the engine, runs and secrets removed` — Delete route could leave active jobs/secrets or remove another workflow: requested active run cancels, only its records/scoped secret go, deleted-scope reads return 404.
- **KEEP** `with the engine: runs, tests, cancels and summaries go through it` — Runtime refusal translation could regress: absent workflow/node/run return 404; stored inactive run cancel returns 409 RUN_NOT_ACTIVE.
- **KEEP** `log windows are redacted and report their position` — Log route could leak values or corrupt cursors: stdout redacts secret while next-offset counts original bytes and headers report EOF/non-live.
- **KEEP** `log follow streams as the file grows and redacts a secret split across writes` — HTTP follow could leak split secret or never end: real streaming response assembles redacted file growth and closes when no longer live.
- **KEEP** `an engine refusal keeps its status, code and problems (never a generic 500)` — Engine errors could become generic 500: status, code and problem array survive both run and test endpoints.
- **REWRITE** `DELETE of a secret refuses prototype names and unknown workflows; Object.prototype is untouched` — DELETE secret route could index unsafe names: nonexistent prototype scope returns WORKFLOW_NOT_FOUND and invalid global name returns 400. Change: Remove direct secret-service calls and Object.prototype inventory already covered by storage-fixes; retain DELETE route status/code validation. Final retained title: `DELETE of a secret refuses prototype names and unknown workflows`.
- **DELETE** `validate returns at once past the hard limits (5 000 blocks)` — Claims prompt completion but only checks validation codes already owned by API validate.test.ts hard-limit cases; no timing or route-specific contract.
- **KEEP** `write routes take a body past 1 MiB, and one past their limit answers LIMIT_EXCEEDED` — Oversized HTTP body could be rejected by Fastify default or lose API error: 1.5MiB reaches validation, >3MiB returns 413 LIMIT_EXCEEDED.
- **KEEP** `account-preview refuses a chain entry it cannot read (400, never 500)` — Malformed preview chain could throw 500: null entry returns 400 INVALID_REQUEST.
- **REWRITE** `the delete cascade keeps a run record whose temp project it could not delete; deletes it directly when it can` — Delete cascade could lose cleanup ownership: with no project service it preserves due run, with service it removes project and run. Change: Drive deletion through HTTP with the existing production projects dependency, instead of importing deleteWorkflowCascade. Remove its test-only export.
- **REWRITE** `expression preview: paths resolve against the latest run, a missing path warns, filters chain` — Preview could omit caller context metadata: selected run, node-relative outline, scalar output, empty missing result and parse-error state match the public response contract. Change: Remove duplicate filter samples and exact warning prose; retain preview wire results, missing/error state, node-relative outline and selected source. Final retained title: `expression preview: returns node-relative data, missing/error state and source metadata`.
- **REWRITE** `expression preview: secrets render as placeholders and a secret inside an output is redacted` — Preview could transform a secret past redaction: text/value modes and upper/json output never contain raw/transformed secret, only placeholders. Change: Remove explanatory-note copy assertion; keep text/value and transformed-secret non-disclosure.
- **REWRITE** `expression preview: the block's point of view decides input; several inputs are keyed by name` — Preview could expose future/self data: self/downstream reads empty with warnings; join input maps Claude/Count and Final receives Join output. Change: Remove warning/explanatory-note wording; keep hidden self/downstream values, warning presence and input mapping.
- **KEEP** `expression preview: value mode keeps a number a number and says when nothing was read` — Value preview could stringify scalars or mislabel absence: 42 remains number, missing has no value, mixed template/JSON filter produce strings.
- **KEEP** `expression preview: pinned outputs replace recorded ones; with no run they are the only data` — Preview could ignore pins or read downstream pins: Count pin=7 overrides recorded 42 only when requested; no-run preview reads only pins.
- **REWRITE** `expression preview: the default run is the latest that reached the block; big outputs are read whole` — Preview could use skipped/newest wrong run or truncated data: Final uses run-1, Join run-2 whole tail, explicit run override and byte truncation work. Change: Remove private lazy-load outline assertion; retain latest-reached-run selection, whole output retrieval, explicit-run override and truncation.
- **KEEP** `expression preview: refusals use the workflow error codes` — Preview could read foreign run or bad shape: unknown workflow/node/run and another-workflow run map 404 codes; empty/templates bad mode map INVALID_REQUEST.
- **DELETE** `expression preview: with the engine attached, runs and whole outputs are read through it` — Arranges engine.nodeOutput=99 but never marks an output truncated, so the asserted 42/3 result never reads that stub. Passes for the wrong reason. Remaining run selection/full-output route case and MCP real run/output path protect actual contracts.
- **KEEP** `expression preview: a block name containing a secret value stays readable (only values are redacted)` — Redaction could corrupt structural identifiers: deployStaging and project.path remain addressable while URL data replaces deploy with placeholder.
- **REWRITE** `expression preview: a starting block of a workflow with no trigger reads the run's input (engine computeForced)` — Triggerless preview could lose raw input: First reads null without history then n=9; Second reads doubled=18; disconnected triggered block receives nothing. Change: Remove explanatory-note wording; keep triggerless root input and disconnected triggered-block behavior.
- **KEEP** `expression preview: rendering stops at the byte cap and parse errors are deduplicated and capped` — Preview could allocate unbounded output/errors: text/value truncate at 256KiB, 100 distinct parse errors cap at 50 with 50 omitted and no duplicate warnings.
- **REWRITE** `expression preview: without a block, a queued newest run gives way to the newest with finished blocks` — Newest queued history could hide useful preview data: source chooses run-1/latest and renders 42 instead of empty queued run. Change: Remove explanatory-note wording; retain newest run with data selection.

### `apps/daemon/src/workflows/run-store.test.ts`

Owner rationale: **store**. Focused command: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test --test-concurrency=2 src/workflows/run-store.test.ts` (from apps/daemon).

- **KEEP** `create/save: run.json is atomic and 0600, the last save wins, the index follows` — Concurrent saves could leave stale state or open permissions: disk ends succeeded at 0600, index agrees and traversal load rejects.
- **KEEP** `init rebuilds the index from the run directories; an unreadable run.json is skipped` — Stale cache could invent/drop runs: rebuild lists new/old valid runs, skips broken/empty/ghost and reproduces same history on next boot.
- **KEEP** `paging: `before` is a run id cursor, newest first; an unknown cursor is a first page` — Cursor paging could duplicate/skip runs: fixed five IDs page newest-first; removed cursor restarts and unknown workflow is empty.
- **KEEP** `sweep keeps the newest 100 and nothing older than 30 days, preserving active runs` — Retention could delete active data or resurrect removed runs: newest 100/<=30days retained, older terminal runs removed and late save/event does not recreate them.
- **KEEP** `sweep keeps a run whose temporary project is still there, until the project is deleted` — Retention could orphan a temporary project: old failed run stays until tempProject.deleted=true, then can be removed.
- **KEEP** `events append as NDJSON; attempt dirs and output files live under the run` — Store could reorder events or escape paths: NDJSON remains 1,2,3, malicious node stays under run, output is 0600 and outside read rejects.
- **KEEP** `deleteForWorkflow removes every run of that workflow only` — Cascade could cross workflow ownership: wf-1 records disappear while wf-2 run-c remains.
- **KEEP** `toRunSummary / persistedRunToWire: bookkeeping stripped, outputs cut to the preview` — Wire serialization could expose bookkeeping or split UTF-8: private fields disappear, small output intact, big preview is fixed 65535-byte-safe prefix and truncated flag.

### `apps/daemon/src/workflows/secrets.test.ts`

Owner rationale: **store**. Focused command: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test --test-concurrency=2 src/workflows/secrets.test.ts` (from apps/daemon).

- **KEEP** `values are stored 0600 (also after an existing file was looser) and never listed` — Secret file could stay world-readable or leak metadata values: writes restore 0600 and list/log contain names/scopes/short warning only.
- **KEEP** `a workflow's own secret shadows a global one; list shows both scopes; deleteForWorkflow removes its own` — Scopes could overwrite globals or delete another workflow: own TOKEN shadows global, deletion restores fallback, reload preserves remaining global and scoped events.
- **KEEP** `names and values are validated: 400 SECRET_INVALID` — Invalid secret names/value types/sizes could reach storage: invalid patterns/nontext/>64KiB reject SECRET_INVALID, exact limit accepted.
- **KEEP** `a foreign-version file is moved aside, without quoting a value` — Newer secret file could be destroyed or logged: original version-2 bytes moved aside and secret absent from diagnostics.
- **KEEP** `an unreadable path makes the store read-only (503) and preserves existing content` — Unreadable secret path could be overwritten: set refuses 503, cascading delete is harmless and sentinel content survives.

### `apps/daemon/src/workflows/service.test.ts`

Owner rationale: **store**. Focused command: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test --test-concurrency=2 src/workflows/service.test.ts` (from apps/daemon).

- **KEEP** `create → read back; persisted atomically at 0600; a reload lists it` — Workflow could disappear on reload or use broad permissions: created disabled revision-0 record reloads identically with 0600 storage.
- **KEEP** `tolerant load: rejected entries and unknown keys are written back verbatim and never listed` — Saving known records could erase future data: malformed/repeated entries stay verbatim and unknown top-level fields survive while only valid unique record lists.
- **KEEP** `a corrupt or foreign-version file is moved aside, never overwritten` — Corrupt/new-version definitions could be overwritten: exact original bytes quarantined and fresh workflow remains writable.
- **KEEP** `an unreadable path blocks mutation with 503 WORKFLOWS_UNAVAILABLE and preserves content` — Unreadable definitions could be silently replaced: mutation refuses WORKFLOWS_UNAVAILABLE and sentinel survives.
- **KEEP** `revisions: +1 on every write, a stale revision is a 409 naming the current one` — Concurrent clients could overwrite changes: replace/patch increase revisions, stale replace/patch/delete reject 409 and current data persists.
- **KEEP** `a bad patch op is 400 INVALID_WORKFLOW naming the op, and changes nothing` — Patch failure could partially commit: opIndex=1 identifies missing block and prior name/revision remain unchanged.
- **KEEP** `a definition with errors saves disabled, but can never be (or stay) enabled` — Invalid automation could become enabled: errors save disabled only, explicit enable/new enabled invalid/edit introducing errors all refuse.
- **KEEP** `a schema-invalid replace is refused whole` — Bad replacement could destroy prior workflow: malformed project/missing body reject typed errors and original definition remains.
- **KEEP** `limits: the workflow count and the definition size are LIMIT_EXCEEDED` — Limits could permit unbounded definitions: 500 existing records prevent create/duplicate; >2MiB replacement data rejects LIMIT_EXCEEDED.
- **KEEP** `duplicate: new ids for the workflow, blocks and connections; disabled; pins follow` — Duplicated graph could collide/refer to original: workflow/node/edge IDs change, edges/pins target new IDs, copy disabled at revision 0.
- **KEEP** `events: upserted after every write, deleted after a delete; the bridge publishes summaries` — Saved changes could leave clients stale: create/patch/duplicate publish summary upserts; deletion publishes ID; unsubscribe stops callbacks.

### `apps/daemon/src/workflows/services.test.ts`

Owner rationale: **services**. Focused command: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test --test-concurrency=2 src/workflows/services.test.ts` (from apps/daemon).

- **KEEP** `resolveExisting accepts exactly <workspacesDir>/<ws>/<project>` — Project addressing could accept workspace/subdir/outside path: exact existing ws/project accepted, invalid shapes/missing/outside rejected.
- **KEEP** `createTemp and deleteProject go through the daemon's routes` — Workflow project adapter could bypass daemon gates: clone uses documented unattended/ref POST, empty uses empty POST, deletion maps to scoped DELETE and 404 is idempotent.
- **KEEP** `a refused create names the daemon's code` — Failed project creation could lose actionable daemon code: NO_GIT_ACCOUNT survives as caller error and detached API rejects.
- **KEEP** `gitStatusShort renders porcelain-style lines within the byte cap` — Agent continuation git summary could mislabel stages or overflow: porcelain M/??/R prefixes and rename paths match Git notation within byte budget.
- **DELETE** `renders {variables} with git reads in the workflow's time zone` — Duplicates resolvePromptVariables variable/timezone behavior through a forwarding adapter with loose date matching. packages/api/src/prompt-variables.test.ts supplies exact Tokyo/New York/Madrid boundary oracles.
- **DELETE** `a failed git read renders nothing and names the variables` — Duplicate resolver failure behavior plus an exact diagnostic fragment; packages/api/src/prompt-variables.test.ts owns no-partial-prompt and failed-read variable reporting.
- **KEEP** `pushes per settings.notify, debounced per workflow and kind` — Notifications could ignore preferences or spam: failure/success have separate debounce, tests/children/cancel do not notify, next minute allows next failure.
- **KEEP** `FIFO past the cap; aborted waiters leave the queue; force skips it` — Resource queue could reorder or leak permits: FIFO surviving waiters, aborted third removed, forced permit and double release cannot over-release.
- **KEEP** `deletes temp projects past deleteAfter and closes old workflow tabs nobody wrote in` — Sweep could delete user-owned/recent work: only expired temp project and old untouched workflow tabs go; edited/recent/active/temp/user tabs remain.
- **KEEP** `runs hourly on the injected clock and stops cleanly` — Sweep scheduler could run early or after shutdown: no deletion at 59min, one at 60min, later stop prevents new due deletion.

### `apps/daemon/src/workflows/state-store.test.ts`

Owner rationale: **store**. Focused command: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test --test-concurrency=2 src/workflows/state-store.test.ts` (from apps/daemon).

- **KEEP** `a missing file loads empty, silently; updates persist atomically at 0600` — Missing runtime state could prevent boot or expose private data: empty state loads without warnings, cooldown survives 0600 write/reload.
- **KEEP** `get() is a snapshot` — A caller mutation could change store without persistence: modifying returned snapshot cannot alter subsequent state.
- **KEEP** `a corrupt file starts empty, is moved aside and logged — never thrown` — Malformed state could prevent boot or destroy evidence: empty recovery logs and original corrupt bytes remain quarantined.
- **KEEP** `bad entries are dropped by the tolerant parse, good ones kept` — One malformed cursor could discard usable state: valid cooldown survives while invalid cooldown/schedule entries drop.
- **KEEP** `an unreadable path starts empty and logs` — Unreadable state could abort startup: directory input loads empty and reports warning.
- **KEEP** `concurrent updates are immediately visible and all become durable` — Concurrent state writes could lose updates: all four keys visible immediately and present after reload.
- **KEEP** `a throwing mutator changes nothing; a failed write retains changes for the next write` — Mutation/write failure could corrupt state or lose progress: thrown mutator changes nothing; failed I/O retains live update and next write persists both changes.

### `apps/daemon/src/workflows/storage-fixes.test.ts`

Owner rationale: **store**. Focused command: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test --test-concurrency=2 src/workflows/storage-fixes.test.ts` (from apps/daemon).

- **KEEP** `a newer build's nested fields survive this build's parse (a save never erases them)` — Older build save could erase nested future fields: schema roundtrip preserves project/notify/position/retry/http-body/git-repo/event extensions.
- **KEEP** `block and connection ids that could key Object.prototype are refused, by the schema and by validation` — Dangerous IDs could index Object.prototype: __proto__ block and constructor edge refuse schema/validation while ordinary punctuation IDs remain accepted.
- **KEEP** `the secrets file keeps what this build cannot read, verbatim, across a write` — Secret updates could discard unknown records: future metadata, rejected global/scope entries and unreadable workflow scope survive a known-key write verbatim.
- **KEEP** `the secrets store never indexes past its own maps` — Secret operations could traverse inherited members: prototype scopes resolve/list empty, unsafe deletes fail, Object.prototype survives and valid delete succeeds.
- **KEEP** `an unfinished run remains recoverable when the index lands before its pending save` — Cache/write race could hide unfinished work: reopening after index completes before run rename still lists r1 running, not cached succeeded.

### `apps/daemon/src/workflows/summary.test.ts`

Owner rationale: **summary**. Focused command: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test --test-concurrency=2 src/workflows/summary.test.ts` (from apps/daemon).

- **KEEP** `the summary carries settings.notify so open clients honour it` — Notification preferences could be omitted from rail events: default {true,false} and custom {false,true} survive summary projection.
- **DELETE** `the summary lists the errors it counts, so the rail can say what they are` — Repeats API validate.test.ts workflowSummaryErrors field projection and catalogue event field assertions; catalogue event test also proves the builder reaches callers.
- **DELETE** `the summary caps its error list and counts the rest` — Repeats API validate.test.ts workflowSummaryErrors cap/omitted-count contract at an extra layer.
- **KEEP** `a changed agent catalogue re-judges a cached definition` — Cached summary could ignore catalog changes: same definition transitions no-catalog=0, unknown=1, probing=0, known=0, unknown-again=1.
- **DELETE** `the validation key moves with the catalogue and nothing else of it` — Compares private cache-key encodings, not validation outcomes. Same-object catalogue-change case retains behavioral invalidation; remove validationKey export.

## Support and production seams

- Remove summary.ts validationKey export: reference search found only summaryErrorsOf in the same module and the deleted key-comparison test; no external production caller. The calculation itself remains private.
- Remove routes.ts deleteWorkflowCascade export: only external caller was its direct test. The real DELETE route already owns the helper; rewritten test exercises that stable route using its existing production projects dependency.
- Remove unused summary extra-node fixture generation and imported guide/recipe/SDK constants, budget helpers, direct cascade/wire helpers, prompt-renderer test import and deleted sandbox compound setup. Runtime dependency injection remains where factory/daemon-wiring supplies it.
- Remove workflows-guide.ts JIRA_FIXER_EXAMPLE/JIRA_FIXER_EDIT_OPS exports after MCP owner coordination: they remain internal guide construction constants; the retained Jira example reads the published guide over MCP, which is the stable author-facing seam.
- Internalize testing/harness.ts nullDaemonApi and testing/daemon-harness.ts quietStoreLogger: repository-wide identifier and dynamic/re-export searches found only same-module consumers. Their values remain required by createHarness/boot; only the dead exports are removed. Risk is limited to import resolution, checked by rerunning all nine harness consumer test files.
- No production behavior changes were necessary. The retained fixture/support files are shared by workflow and agent tests; no entire fixture becomes unreachable.

## Validation

Implemented dispositions: **13 DELETE, 12 REWRITE, 153 KEEP**. The 165 remaining tests across all 16 assigned files passed with **0 failures, 0 skipped, 26 suites**. Command: the per-file focused command above, with all assigned file paths supplied together and `--test-concurrency=2`. Output: `/tmp/orquester-test-audit/scope-18-focused.tap` (142.3 seconds).

After internalizing the two unused harness exports, all nine harness consumer files passed again: **96 tests, 24 suites, 0 failures, 0 skipped** (48.8 seconds). The same Node import hooks and concurrency bound were used with catalog-events, e2e, e2e-mcp, e2e-agent, engine-fixes, engine-resume, engine, integration and nodes/nodes test files. Output: `/tmp/orquester-test-audit/scope-18-support-final.tap`.

The pre-edit baseline started before the interrupted agent session; its partial log contains no observed failures, but it did not complete. It was not rerun or represented as a successful baseline. Post-edit verification completed successfully.

The E2E harness preserved persisted-run/event artifacts, including `/var/lib/orquester/tmp/orq-workflow-evidence-WIxrFH/results.json`; all ten artifact paths are recorded in the focused test log. Reviewed the complete scoped diff, checked every removed export's remaining references, and passed `git diff --check`. Root owns repository-wide lint/typecheck/test/build gates.
