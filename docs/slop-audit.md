# Repository cleanup audit

Baseline: `9675e822`. The audit covered every workspace package, daemon subsystem,
provider adapter, test tree, frontend entry point, and repository tooling. Generated
provider bindings, captured fixtures, assets, and historical design records were
checked for ownership and use, rather than rewritten. No live daemon or deployment
was operated.

Changes require either repository-wide evidence of no consumers, an equivalent
expression, or a test covering the retained behavior. An export being absent from
production callers alone did not justify deleting a protocol contract or a useful
test observation interface. Private packages' internal exports were narrowed only
after checking imports, re-exports, tests, and entry points.

The tables record the reason, material risk, and verification for each group of
changes. Paths are relative to the named scope. Compiler-only export/import changes
are grouped because their common verification is the full repository typecheck.

## Shared API, config, and registry

| Change | Evidence / reason | Risk / verification |
| --- | --- | --- |
| Delete synchronous workflow rule/rules/switch evaluation; simplify matcher job | Only its own tests used it; daemon flow nodes already use the async evaluator and isolated regex worker. | Matcher wiring: migrated every operator, combination, pattern refusal/cap and switch assertion to the production async APIs; worker timeout coverage remains. |
| Delete `latestFailureReason` and its two exclusive tests | Actual failover calls `failureReasonOfActivity`; the selector had no callers. | Missed consumers: repository references and typechecks; retain all structured/legacy failure-reader tests. |
| Delete `canResumeAgent`, `isBackgroundTaskActivity`, event-name arrays and duplicate receipt constant | No callers; live event unions, routing names and receipt cap remain elsewhere. | Missing static dependency: repository typechecks; no wire union changed. |
| Delete unused config log/raw/receipt/account-home helpers and default todo/prompt/workflow factories | No consumers except one literal path assertion. | Missing callers: references/typechecks; persisted parsing and live path helpers unchanged. |
| Delete private HTTP `put`; inline single-use prompt formatters | No `put` callers; formatters merely forwarded identical output. | User-visible text: prompt-variable/error tests retain exact expectations. |
| Remove two literal-default/path tests; clean up filesystem fixture | Tests restated constructors; parsing/defaulting/rejection tests remain. Temporary directory previously leaked. | Test-only: config suite passes. |
| Shorten phase, snapshot-version history and call-anchor commentary | Historical implementation narrative obscured current rules. | Documentation: retained cache-version bump requirement, legacy anchoring behavior and first-party installer restriction. |

## Daemon runtime, accounts, and usage

| Change | Evidence / reason | Risk / verification |
| --- | --- | --- |
| Delete empty OpenCode history stub | It always returned `[]` and contributed nothing to the flattened result. | Conversation listing: existing project/system/managed-home tests. |
| Inline launch-env composition and Claude tool-name predicates | One caller; second environment contribution can only contain `env`; predicates reduce to the same equality. | Precedence/credential removal: expanded existing timeout collision assertion; classifier equivalence checks. |
| Delete unused search argument, filesystem query constant, auth/opener helpers, package version and todo loaded flag | Whole-repository references and compiler diagnostics prove they are unread. | Security: real auth, filesystem containment, registry opening and todo persistence paths retained; focused route/search/registry tests. |
| Remove redundant registry object spread | Object rest already produced the same secret-free new object. | Secret leakage: existing public-registry test checks omitted env and unchanged internal env. |
| Remove accounts redactor/find wrappers and duplicate filesystem imports | Same functions/arguments; lookup has one caller. | Account errors/redaction: clone, remote and filesystem tests. |
| Remove unused known-host count results and configurable timeout | Callers discard counts and never override the existing timeout. | Refresh behavior: same 5-second bound, append/permissions logic; known-host tests. |
| Merge duplicated Codex credential-env test | Identical account setup; differing assertion moved into retained test. | Credential handling: both home and unset-key assertions retained. |
| Remove total-cost wrapper; test pricing through aggregation | Wrapper had no production calls and duplicated the live sum. | Accounting: preserved model suffix, unknown-model, mixed TTL, total and component cost cases; no prices changed. |
| Remove repeated transcript label plumbing | Directory/parser selection already fixes the same agent label. | Attribution/dedup: managed-only and mixed-home totals, append/tail/truncation and realpath tests. |
| Merge duplicate plan capitalization and Claude reading fields | Identical formatting functions and repeated `scopedWindows` spread. | Live limits: parser, rate-limit, expiry and restart tests. |
| Replace Map-forwarding test class; remove unused usage clock option | Class added no semantics; service never read injected clock. | Persistence: real file-load tests retain invalid-record, round-trip and corruption checks. |
| Narrow private runtime/account/usage exports; remove compiler-proven unused imports/bindings | No consumers; retained implementation and public service contracts. | Compile-time only: repository typecheck. |

## Agent chat service and git providers

| Change | Evidence / reason | Risk / verification |
| --- | --- | --- |
| Delete chat-session prefix-close duplicate | No caller; live router already owns host deletion and tab closure. | Lifecycle: session/index tests; real close path unchanged. |
| Delete host-client socket getter and service's inert handle bookkeeping | Getter unread; handle only assigned/cleared against itself. Supervisor owns actual process handle. | Ownership: direct/tmux supervisor and service lifecycle tests. |
| Inline activity/error wrappers and remove unused default arguments | Single-caller field checks/switch/table lookup with identical branches. | Attention/error mapping: ladder, summary and proxy-route suites. |
| Remove second pending-request validation pass | Private path receives rows from the existing boundary sanitizer. | Malformed JSON/duplicates: sanitizer remains; existing test expanded to confirm last duplicate wins. |
| Trim chat-client barrel and provider scaffold | Removed re-exports have no consumers; provider registry is complete. | Static dependency: typecheck; unknown-provider runtime rejection retained. |
| Move GitHub list/create bodies into sole provider methods | Extra token-only methods and duplicated options only forwarded calls. | HTTP semantics: provider tests plus mocked pagination, malformed row, user/org, payload and header-only credential checks. |
| Replace stale home-prep history with current invariants | Old narrative described behavior already removed. | Documentation: confinement, symlink-aware atomic writes, mode 0600 and Grok overlay rules retained. |

## Agent host orchestration and checkpoints

| Change | Evidence / reason | Risk / verification |
| --- | --- | --- |
| Delete stale command set, unused failure/launch/error declarations and compatibility re-export | Router uses current API command names; only re-export consumer was a test. | Protocol: retained current names/types, validation and command tests; test imports API directly. |
| Reuse actual host-summary/usage wire types | Two interfaces duplicated the real socket contract. | Compile-time only: fields compared and typechecked; type-only dependency. |
| Delete replay-size cache | Sole caller measures newly parsed log objects; live streams never used it. | Replay budgets: identical UTF-8 JSON measurement of the slimmed row; overflow/fallback/pagination tests. |
| Delete unread deferred/queue bookkeeping; inline snapshot/router wrappers | Native promises already settle once; queue size is unread; wrappers only forward calls. | Ordering/recovery: retained rejection handlers and drains; readiness, queue, provider and HTTP suites. |
| Iterate liveness Maps directly | Loops synchronously delete only current entries, with no callbacks or insertions. | Iteration order: TTL, mixed-task, wake and turn-boundary tests. |
| Use `CheckpointService` input types directly | Local interfaces duplicated the authoritative contract and had no external consumers. | Compile-time only: field comparison and typecheck. |
| Derive checkpoint counts from existing ref listing | Both functions ran identical bounded git command and parsing. | Data safety: same error-on-truncation, namespace and numeric sort; capture/prune/stray-ref tests. |
| Inline checkpoint remember wrappers; compare one unsupported adapter directly; remove identical catch branch | Equivalent operations with no shared policy lost. | Replay/rollback: stale, reverted, sparse-count, recovery and provider tests. |
| Remove unused fixture options/fields and replace shell mkdir | Every caller initializes a repo and no caller reads exposed home. Native recursive mkdir replaces test subprocess. | Test-only: all 52 checkpoint tests pass; git isolation remains. |
| Narrow internal host exports and remove unused test bindings | Whole-repository references/compiler diagnostics. | Compile-time only; no setup calls/assertions removed. |
| Correct ignored-SIGTERM integration test | It calls in-process `host.stop()`, never the SIGTERM entry point whose backstop its wall-clock assertion claimed to test. Scheduler and process scanning inflated elapsed time. | Retain actual helper launch, awaited stop and helper death; focused case passes. Exact grace remains covered by the adapter test. |

## Host storage, ingestion, and support

| Change | Evidence / reason | Risk / verification |
| --- | --- | --- |
| Delete SQLite forwarding object | Native database satisfies the same structural interface; consumers keep receivers and ignore method return values. | Driver/transaction behavior: real SQLite index suites; binding probe, permissions and cache recovery retained. |
| Store latest completion index instead of every completion | Any later completion exists exactly when the maximum index is later. | Ordering/turn identity: expanded reused-call test covers multiple completions and final live update. |
| Narrow queued activity event type; delete identity role mapper | Runtime guard already identifies activity events; role mapper returns the same role. | Ingestion: stream, ownership, batching and coalescing tests. |
| Delete unused fixture getters, store sweep alias and redundant mkdir | No callers; scheduled/startup sweeps remain; atomic writer already creates parent. | Persistence: binding/store creation/reload tests; README corrected. |
| Delete write-only NDJSON counter | No reader in source/tests; cap and resynchronization state remain. | Framing: new regression checks repeated oversized chunks then valid next line. |
| Inline plan-ID wrapper, narrow local exports, correct stale comments | Same IDs/coercion; no export consumers; comments contradicted current identity behavior. | Typecheck and ingestion tests; redaction logic unchanged. |

## Provider adapters

Generated bindings and retained protocol captures are unchanged. The incoming
cleanup removed five unused Claude captures and updated their provenance README;
fixture documentation and consumers were checked during integration.
Unknown-event warnings, provider-specific compatibility,
process shutdown, approval handling, resume identity and observed protocol tests remain.

| Change | Evidence / reason | Risk / verification |
| --- | --- | --- |
| Delete unused Claude UUID/subagent/URL helpers, version markers and queue accessors; OpenCode cloning method/todo route | Repository reference/import scans found no callers. | Missing indirect use: provider replay/lifecycle suites and repository typecheck. |
| Remove safe-JSON alias, unread Claude reason/result state and unused replay helpers | Sole forwarding call or compiler-proven unread data. | Event normalization: replay tests retained; no fixture expectations loosened. |
| Simplify Claude/OpenCode deferred helpers | `settled()` was unused; native resolve/reject already ignore subsequent settlement. | Promise lifecycle: deliberate rejection handling retained; stop/request tests. |
| Delete Codex approval alias and unused usage cleanup method; simplify identity ternary | No callers; both ternary arms were the same value. | Approval/usage/protocol suites. |
| Delete Grok metadata/fixture helpers, unused ACP error predicates/getters/barrel | No consumers; actual classifiers/readers remain. | RPC/error/context/lifecycle suites; no provider support removed. |
| Collapse equivalent ACP branches and redundant async Promise wrapping | Same class/code outcomes and values; no following catch/finally work. | Error/plan/lifecycle tests. |
| Narrow internal adapter exports | Referenced only inside their own module; generated/public protocol declarations retained. | Full repository typecheck; export-only diffs separately reviewed. |
| Correct Grok lifecycle mock-clock driver | An unrelated 2-second stdout watchdog could advance fake time before the helper grace starts. Only grace-range timers drive this measurement now. | Exact 1,000 ms SIGTERM-to-SIGKILL assertion and real process death retained; complete 87-test lifecycle suite passes. |

## Native agent profiles

| Change | Evidence / reason | Risk / verification |
| --- | --- | --- |
| Delete interim `seams.ts` and require converter | Sole production service constructor already supplies real converter/import store; scaffold duplicated canonical interfaces. | Construction/secret flow: all call sites inspected; tests explicitly supply doubles and retain secret-boundary checks. Missing-import 503 unchanged. |
| Delete unused conversion helper/default temp root and duplicate `tempDir` metadata | Production uses appdir-scoped converter and owns skill `item.dir`; metadata had only test readers. | Cleanup ownership: tests now assert actual directory and content; conversion suite. |
| Delete hook parser and stash destructive-read helper | Only their own tests used them; live adapters use lookup then remove after successful restoration. | Recovery: active hash/hook/stash lifecycle and conflict tests retained. |
| Remove duplicated infra API manual, direct-call/watch wrappers and repeated validation | Implementations document APIs; installed-adapter lookup already validates before every operation. | Boundary/lifecycle: route, unknown-agent, watcher and import tests. |
| Delete unused Claude JSON reader; inline plugin-cache and secret-digest forwarding | Actual readers and same shared digester remain; Grok no longer imports Claude solely to reach shared utility. | Locking/revision/redaction: native adapter suites. |
| Remove Codex unused CLI dependency/re-export and instruction-read wrapper | No dependency consumers; both reader paths use identical implementation. | Config-client and instruction tests; typecheck. |
| Narrow internal profile exports | No imports/re-exports outside definitions. | Compile-time only: repository typecheck. |

## Workflow engine and MCP

| Change | Evidence / reason | Risk / verification |
| --- | --- | --- |
| Share persisted/engine run summary | Duplicate field inventories and cast; optional structured fields keep store clone isolation. | Wire whitelist/isolation: compared all fields; run-store/engine tests. |
| Reuse JSON byte counts and UTF-8 clipping | Existing algorithms were identical. | Limits/Unicode: independent expected-byte, clipping, output-cap and handoff tests retained. |
| Delete tests-only selection/secret helpers and unused chain-start option | Production uses `selectAccount`/`onlyChainIndex`; exact redacted-text assertion already covers secret detector. | Failover: test redirected to live selection API; no-fallthrough/reset assertions retained. |
| Inline workflow error/exit wrappers; delete unused barrels/exports/test fixtures | Same expressions or no callers. | Route/sandbox/engine suites; typecheck. |
| Inline MCP fixed-error, join, UUID, schema and tool-list wrappers | No transformation beyond retained expression; tool arrays have no mutation consumers. | Tool order, strict validation, receipts, retry and sandbox tests. |
| Delete private todo mark field and redundant tool-array casts | Mark unused after parsing; arrays already carry declared type. | Exact-byte toggle/idempotency tests; stronger compiler assignment checking. |
| Narrow MCP exports and remove stale fixed-count comments | No consumers; live contracts/validation remain. | Repository typecheck and complete 422-test MCP suite. |

## Shared UI and frontends

| Change | Evidence / reason | Risk / verification |
| --- | --- | --- |
| Delete unused catalog/resource hooks, service and Tooltip | Whole chain had no callers. | Missing imports: repository typecheck/build. |
| Call ApiClient directly instead of workspace service | Service only forwarded same arguments/results. | Request/state behavior: app-store/project-index tests; both frontends build. |
| Remove dead API methods, font-size action, todo context field, session/prompt/error helpers and exports | No live consumers; nudge action and daemon routes retained. | State/persistence: focused store/session/history tests; typecheck. |
| Remove write-only browser focus state and unused imports | Callback still uses existing focus ref; compiler identified unused values. | Browser behavior: ref/setter flow reviewed; build. |
| Delete disconnected question model and exclusive tests | Mounted card uses `pending-answer.ts`; removed module appeared only in its tests/barrel. | Answers/secrets/uploads: active question/banner tests retained. |
| Delete unused plan/context/roster/queue/presentation/diff/frame/disclosure helpers and orphan tests | Actual components use different live implementations; references checked through barrels. | Rendering/queue: retained tests for actual components, follow-up disposition, context meter, failure display, diff parser and cursor logic. |
| Remove roster re-export module; inline follow arithmetic; combine identical thread-switch branches | Same implementation and predicates, with same-thread interactivity preserved. | Scroll/thread switching: follow tests and all seven switch cases pass. |
| Remove obsolete question props/types and unread calculations/fixtures | Props never supplied/read; secret flag already in shared question type. | Types only except unused computation: typecheck; per-option compatibility retained. |
| Remove Runs renderer registration/fallback and unused props | Sole registration always installs same component at AppShell load; no alternate prop users. | Module evaluation: direct same component, run selection tests and both frontend builds. |
| Delete unused workflow helpers/palette/Pill and tests-only wrappers | No runtime callers; connection tests redirected to actual refusal API. | Graph/path behavior: existing connection, catalog, run-view and JSON tree tests. |
| Inline three profile form signatures and save-error wrapper | Each only called JSON.stringify or returned a fixed string. | Dirty state/error text: identical inputs and wording; editor logic/render checks. |
| Remove source-regex editor/reset assertions | They pin spelling/order without executing lifecycle behavior. | Coverage limit: retained executable render, key/focus, event-routing and store-reset tests; static renders do not prove effects. |
| Remove obsolete phase/owner/wave commentary | Components/hooks are implemented; repetitive historical editing rules no longer apply. | Documentation only; current behavior and attribution retained. |
| Remove unread desktop preload metadata and private bridge exports | Only renderer type declarations mentioned fields; actual endpoint uses existing env independently. | IPC: consumer review, desktop typecheck/build. |
| Import build-time copyFile statically | Same module already imported; dynamic import added no boundary. | Packaging: full desktop build verifies copied assets. |
| Remove unused UI WebGL/CVA dependencies and web API dependency | No imports; web reaches API through shared UI's declared dependency. | Resolution/bundling: frozen install and both builds; lockfile removes only these entries, preserving existing peer versions. |
| Remove deployment links to nonexistent design files | Referenced files do not exist; current deployment entry point is deploy.sh. | Documentation only; shell syntax checks. |
| Delete duplicate node_modules ignore entry | The first identical pattern already covers it. | Same ignore behavior; git check-ignore confirms package and root dependencies remain ignored. |

## Incoming remote changes

Remote `main` advanced to `8d216c11` during verification. Its agent-profile kind tabs
and thirteen MCP profile tools were reviewed and integrated. The MCP registration
conflict retains every incoming tool in the simplified static tool list.

| Change | Evidence / reason | Risk / verification |
| --- | --- | --- |
| Reduce repeated static tab-render cases to one per variant | Five width cases repeated identical tab assertions; tabs do not consume width, and server rendering cannot measure wrapping. | Retain docked/phone markup, accessibility, selection, keyboard, filtering and storage checks; remove unsupported physical-fit claims. |
| Narrow two MCP profile helper exports; remove redundant array assertion | No external consumers; the declared tool-array type already checks assignment. | Repository typecheck and MCP profile tests. |
| Redact complete URL userinfo in MCP profile summaries and metadata | The original matcher stopped at the first `@`; real adapters also expose URLs in description and metadata, bypassing the detail view's redaction. | Proven behavior correction: regressions include multiple `@` characters and real OpenCode routes, with the configured URL unchanged on disk. |
| Preserve conflict error when refresh fails | A failed snapshot refresh was incorrectly reported as proof that the item was deleted. | Proven behavior correction: write-conflict plus unavailable-refresh regression preserves the original error; successful refresh still enriches conflicts. |

## Integration of upstream test cleanup

While the verified cleanup commit `d079cdbd` was being prepared, upstream advanced
to `0b773dc9`, incorporating test cleanup `7f3516cd`. Each subsystem owner reviewed
the incoming runtime changes, deleted assertions, surviving coverage, and automatic
merges. The incoming dead test seams, private exports, receipt-based waits, and
justified duplicate-test deletions were retained. The following corrections keep
distinct behavioral contracts covered without restoring broad duplicate matrices.

| Merged decision | Reason / risk | Verification |
| --- | --- | --- |
| Keep the verified assertion fixture from `d079cdbd` | Incoming readiness code still used CommonJS and changed the position-sensitive fixture; source-message checks were absent. | Positive/negative controls and the complete pre-merge suite; unchanged ten-second assertion deadline. |
| Keep incoming authenticated HTTP stop/handover tests | They exercise the actual route and awaited shutdown callback, replacing manual mark/stop calls and wall-time assumptions. | Real helper termination and handover checks. |
| Keep the existing OpenCode recycle drain and later-idle regression | Removing the drain also removed the only proof that a deferred recycle is consumed once. | Real server replacement, then no second replacement on later idles; no sleeps. |
| Retain a focused Codex compact request test | Inbound normalizer replay cannot detect a missing outbound RPC or wrong provider thread ID. | Actual method and parameter contract through the existing mock server. |
| Retain ingestion forget/liveness coverage | Session-exit cleanup does not exercise explicit forget. | Real registry count transitions from one live task to zero. |
| Retain encoded command IDs, empty instruction revisions, locked-file refusal, and Codex client rotation tests | Service or parser tests do not cover these HTTP, locked-write, or process-lifecycle boundaries. | Literal encoded route, create-if-absent revision, unchanged malformed file, and actual old-client process exit. |
| Retain summary push suppression and valid continuing goals | Ladder unit tests cannot detect incorrect summary wiring; false-only fixtures cannot detect a dropped true flag. | Live-background error notification case and boundary sanitizer assertions. |
| Retain Bitbucket endpoint origin/context-path coverage | A permissive polling mock would accept a request that silently dropped the configured base path. | Path/origin checks independent of request order or query ordering. |
| Wait for BEL attention rather than the first PTY output chunk | Ordinary output can arrive before the chunk containing BEL. | Event-driven condition wait with the existing deadline and real PTY tests. |
| Preserve caller-supplied workflow positions and usage cost provenance | These are persisted user data and scanner output contracts, not incidental layout or helper representation. | Assertions folded into existing create/add and incremental scanner tests. |
| Retain silent-continuation baseline and auth-cause prompts | A shared text reader does not own the backward turn scan; usage-limit text is wrong for authentication failure. | Existing continuation and switch/handoff tests, with direct output assertions. |
| Retain MCP subscription disposal, bounded waiting, and structured pending details | Lower-level waits use another subscription; message text alone does not prove programmatic response details. | Existing request/wait tests plus the retained URL credential and conflict regressions. |
| Retain plan copy, generated-prompt ownership, insertion boundaries, answer clearing, and preview disposal | Helper tests or directly seeded state miss these live caller contracts. | Compact existing-case assertions, including actual Blob URL revocation. |
| Retain prompt-history selector identity and counts above one | External-store subscriptions require a new reference; a single-item fixture cannot detect a count-always-one bug. | Existing selector test and a two-MCP profile fixture. |
| Remove obsolete SSR scripts and newly orphaned UI forwarding exports | Source/markup inventories did not execute effects; incoming changes removed the final forwarding consumers. | Keep the live keyboard decision, form, persistence, and rendering-source typechecks; no claim of DOM interaction coverage. |
| Remove the MCP E2E success artifact and leftover redactor local | The artifact hardcoded success and duplicated responses in an unmanaged temporary directory; the local only forwarded its object. | Retained real HTTP assertions and streaming redactor tests. |
| Condense incoming disposition ledgers | Thousands of unchanged-test KEEP rows and repeated methodology added little beyond the source tests. | Preserve concrete change reasons, risks, unique safeguards and provenance; original ledgers remain in `7f3516cd`. |

The files under `docs/test-cleanup` describe that incoming historical audit. This
section records where its proposed removals were superseded during integration.

## Retained complexity

Preserved authentication and secret handling, realpath containment, append-only log
ordering, snapshot/index recovery, resume compatibility, process ownership, deadline
and cancellation handling, persisted workflow waits, native configuration tolerance,
provider-specific parsing, and their independent regressions. Similar code with
different error, ordering, ownership or compatibility semantics was not merged.
The reference API client, deferred index boundary, and test observation interfaces
remain useful despite superficial wrapper shapes. Package-local warning preloads
remain unchanged, avoiding a new test infrastructure abstraction.

## Verification

Focused tests and independent reviews accompany the changes above. The initial
installation lacked declared agent-profile dependencies; a frozen install restored
them without upgrading packages. An early compiler diagnostic ran during edits and
was used to find unused declarations, not as an acceptance gate.

The first complete repository test run passed 6,293 of 6,294 tests. The sole failure
was an existing assertion-preload regression fixture: its temporary `.ts` file ran
as CommonJS outside the repository's ESM package, bypassing the callable-assert ESM
hook and entering Node's problematic native message generator. Inspector confirmed
the native stack without changing the fixture source. Using `.mts` selects ESM.

Subsequent measurements also found healthy preload startup taking 14.216 seconds
under host contention, followed by 2.307 seconds for fixture import and assertions.
The test now gives startup a separate 30-second cap and uses an IPC handshake before
arming the unchanged ten-second assertion watchdog. The handshake lives in a
temporary runner, outside the position-sensitive fixture. Both AssertionError
checks and source padding remain; the test also requires the correctly mapped
source expression in each error message. This matters because native Node can
sometimes finish with the wrong message instead of hanging. The identical fixture
without the shim failed with `Wrong assertion source: false == true`, while the
configured test passed. No assertion preload implementation changed.

Final validation after integrating `0b773dc9`:

- `pnpm check`: all seven workspace packages passed after the final fixture change.
- `pnpm test`: 5,792 tests passed (config 26, API 400, daemon 4,126, UI 1,240),
  with no failures, cancellations or skips; all package check
  scripts passed. Workspace concurrency was one with eight available CPUs to
  reduce shared-host contention; no tests were filtered out.
- `pnpm build`: web, desktop main/UI, and Linux AppImage packaging passed. Existing
  desktop CommonJS/`import.meta`, bundle-size, and packaging metadata warnings remain;
  packaged desktop startup was not exercised.
- The existing browser smoke script passed both clean-storage and legacy-preference
  scenarios against the emitted web bundle, with no reported page errors. It used an
  isolated static server with synthetic authentication responses, so it verifies
  application startup and the authentication shell, not authenticated workflows.
- After Electron packaging, the original Node native binaries were restored and
  verified with a real SQLite query and a PTY subprocess that exited successfully.
- Shell/JavaScript syntax checks, dependency ignore checks, and final diff review
  passed. No generated provider bindings, runtime data, or build outputs are included.
