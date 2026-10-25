# Root, box-agent, desktop shell and web-worker audit

Baseline: `bff9af49`. Scope: all 20 files from the root ownership inventory, plus the two standalone `scripts/smoke-web.mjs` scenarios. Read each baseline declaration and current production owner, and reviewed the applied diff. This report documents the root agent’s implementation; this documentation workstream changes no source/tests and runs no tests.

## Exact accounting

Counts are source declarations, before parameter expansion: Go `func Test…(t *testing.T)`, imported Node `test(...)`/`it(...)`. Suites, Go `t.Run` cases, `TestMain`, subprocess helpers and regular-expression `.test(...)` calls are not extra declarations. Baseline names/line numbers below identify the original declaration even when renamed. Each consolidated row explicitly identifies whether its declaration survives.

| Scope | KEEP | DELETE | REWRITE | OPTIMIZE | CONSOLIDATE | Total | Surviving declarations |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 20 test files | 85 | 10 | 24 | 0 | 6 | 125 | 112 |
| Standalone browser scenarios | 2 | 0 | 0 | 0 | 0 | 2 | 2 scenarios |
| Audit rows combined | 87 | 10 | 24 | 0 | 6 | 127 | 112 declarations + 2 scenarios |

The six CONSOLIDATE rows comprise three removed declarations and three surviving owners; DELETE removes ten more. No declaration is added. Rewrites include replacement of test-only timer injection with native virtual time, but are counted once as REWRITE, not again as OPTIMIZE.

Test-source LOC: **2,991 → 2,788 (−203)**, from `git diff --numstat bff9af49` over exactly the 20 inventory files: **177 added / 380 removed**. All 20 files survive. The smoke script/fixture is unchanged and excluded from this LOC subtotal. Deleted universal preload infrastructure is accounted separately below, avoiding double counting with package test ledgers.

| File | Baseline declarations | Surviving | Baseline LOC | Final LOC |
| --- | ---: | ---: | ---: | ---: |
| `apps/box-agent/internal/agent/agent_test.go` | 6 | 4 | 132 | 97 |
| `apps/box-agent/internal/agent/exec_unix_test.go` | 8 | 8 | 283 | 295 |
| `apps/box-agent/internal/agent/orphan_linux_test.go` | 4 | 4 | 211 | 211 |
| `apps/box-agent/internal/agent/proc_unix_test.go` | 7 | 6 | 459 | 457 |
| `apps/box-agent/internal/agent/service_linux_test.go` | 2 | 2 | 47 | 38 |
| `apps/box-agent/internal/wire/wire_test.go` | 5 | 5 | 207 | 207 |
| `apps/box-agent/src/build.test.ts` | 2 | 1 | 43 | 57 |
| `apps/box-agent/src/fixtures.test.ts` | 3 | 3 | 43 | 43 |
| `apps/desktop/src/http-stream.test.ts` | 6 | 4 | 141 | 113 |
| `apps/desktop/src/menus.test.ts` | 5 | 5 | 140 | 80 |
| `apps/desktop/src/native-notifications.test.ts` | 7 | 5 | 145 | 90 |
| `apps/desktop/src/navigation.test.ts` | 11 | 11 | 144 | 144 |
| `apps/desktop/src/transport/stream-status.test.ts` | 4 | 4 | 35 | 35 |
| `apps/desktop/src/window-lifecycle.test.ts` | 5 | 5 | 38 | 38 |
| `apps/desktop/src/window-state.test.ts` | 9 | 8 | 112 | 108 |
| `apps/web/test/sw.test.mjs` | 15 | 13 | 305 | 286 |
| `deploy/lib/remote-update.test.mjs` | 7 | 7 | 209 | 209 |
| `scripts/check-changed.test.mjs` | 7 | 7 | 114 | 114 |
| `scripts/deploy-public-url.test.mjs` | 4 | 3 | 71 | 58 |
| `scripts/ensure-node-native.test.mjs` | 8 | 7 | 112 | 108 |

## Removed infrastructure and production seams

- Removed `scripts/test/assert-ok.mjs` (164 lines), `assert-ok-hooks.mjs` (39) and `quiet-mock-timers.mjs` (21): **224 preload LOC** plus references/flags in package runners, standalone-check runners, `check-changed` fixtures, AGENTS.md and README. These were a Node 20 assertion-source workaround and experimental-warning suppression, obsolete on the README-supported Node 24 LTS runtime. The obsolete assertion regression declaration belongs to the daemon_core ledger and is not counted again here.
- The root runtime probe on Node **v24.22.1**, without either preload, observed both long-tsx falsy assertion entrypoints emit the correct source expression and `AssertionError`; assertion CPU was **50.173 ms** (child wall **1,259.780 ms**). Native mocked timers fired with no stderr/warning. These are compatibility probes, not repository behavioral tests or a suite speedup measurement.
- Removed build-only exports `goTargetFor`, `GoTarget` and `executableFormat` from the box-agent package surface after caller search. Target mapping/type remain private builder internals; executable header interpretation is now an independent test oracle. `buildBoxAgent`, `executableName` and manifest/build options retain production callers.
- Removed NotificationRegistry timer-injection interface, constructor lifetime/timer parameters and private-size accessor; made `BADGE_MAX`/`NOTIFICATION_HOLD_MS` private. The production caller always used defaults. Tests observe actual replacement/release/expiry through `hold()` with native virtual time. Production badge description/bitmap functions remain because main.ts uses them.
- Removed RendererOutbox custom-capacity constructor and size accessor; the sole production caller used its unchanged 20-message default. FIFO one-shot delivery survives; the arbitrary cap is no longer a required expectation.
- Replaced a skipped Go helper test declaration with non-test TestMain fixture dispatch. Real moved-process-group signaling still runs in its surviving regression owner.
- No dependency, fixture corpus or snapshot is removed in this scope. Checked-in protocol goldens and the historical browser-storage fixture remain independently justified compatibility artifacts. Existing native guard injection stays: these options isolate real external compiler/probe side effects and the CLI uses their defaults; no new seam is introduced.

## Reading the six-bar evidence

For each file, the source and seam establish an independent specified contract, the oracle can disagree with production, refactor reasoning excludes implementation details, and uniqueness identifies why a stronger owner does not supersede it. Each exact row then states its recognizable failure and specific oracle/remaining owner. Risk/validation apply to the corresponding file, not a blanket permission to retain cases. DELETE rows name the failed bars.

### `apps/box-agent/internal/agent/agent_test.go`

**Independent source / real failure:** packages/api/src/box-protocol.ts (transport, detached offsets and fs.watch ignore parameter), agent.go URL/OIDC audience contract, exec.go documented environment precedence and watch.go documented match semantics.

**Stable seam:** Functional URL/audience, environment-content and watch-matching boundaries; the detached-output buffer read/bounds/finish contract, not its chunks/map/locking representation.

**Independent oracle:** Handwritten URL/path match and env literals; literal tagged byte sequences, independent byte offsets and an observed wakeup.

**Refactor resistance:** Surviving assertions use content, URLs and matcher outcomes; order-only env and pending-map expectations are removed.

**Unique protection:** The cheap buffer owner covers partial-chunk offsets/stream tagging/wakeup missing from channel integrations; URL/ignore/override cases have no stronger Go owner.

**Production callers:** Agent.connectOnce, OIDC authentication, processEnv, watch scanning/native watchers, detached viewer replay. **Risk/cost:** Medium: protocol and filtering regressions affect box connectivity/output. Isolated pure units have no daemon/container startup.

**Validation target (root-scheduled; no new execution claimed):** `cd apps/box-agent && node scripts/go.mjs test -race ./internal/agent`.

| Baseline line | Exact baseline test name | Disposition | Specific contract, credible failure and surviving owner |
| ---: | --- | --- | --- |
| 11 | `TestEveryHostToBoxMethodHasAHandler` | DELETE | Fails real-outcome, stable-seam and refactor bars: compares two private handler-name maps without invoking an RPC. Wire golden method compatibility and actual channel/RPC tests remain; map membership cannot prove a handler works. |
| 24 | `TestRingKeepsNewestBytesAndReportsStart` | KEEP | Literal hello/world! chunks prove merged stdout/stderr offsets, a partially evicted chunk, bounded reads, explicit overrun and finish wakeup. Credible failures are wrong byte offsets, stream tags or a stranded reader; channel tests do not isolate these boundaries. |
| 59 | `TestConnectURL` | KEEP | Literal HTTP→WS/HTTPS→WSS connect URLs preserve a daemon sub-path, reject FTP and strip the path from the OIDC audience. Wrong scheme, endpoint or audience would prevent authentication; no launched-agent test covers these URL combinations. |
| 79 | `TestEnvMergeOrder` | REWRITE | Now TestEnvMergeOverridesAndDeletes: sorts the returned key/value list, retaining literal A=1, C=4, D=5 after deletion, replacement and addition. Environment content is the contract; the old insertion-order expectation was incidental. Other process tests cover defaults/secrets, not explicit override/delete semantics. |
| 96 | `TestWatchCoalescing` | DELETE | Fails stable-seam and refactor bars: locks the private pending map and checks its coalescing representation/timer, without observing a delivered fs.change event. No independently specified exact intermediate map state is lost; protocol event-shape fixtures and ignore semantics remain. |
| 119 | `TestWatchIgnore` | KEEP | Literal ignored/not-ignored paths establish documented fs.watch ignore matching for a segment, wildcard and relative directory prefix, with allowed siblings. A matcher that leaks node_modules or suppresses src fails; host-side watch tests cannot exercise the separate Go implementation. |

### `apps/box-agent/internal/agent/exec_unix_test.go`

**Independent source / real failure:** box-protocol.ts channels/flow control/detached resume/Secrets; agent.go daemonClient credential redirect prohibition; exec.go service HOME/USER defaults; Unix channel path validation contract.

**Stable seam:** Actual Go agent WebSocket channel messages plus real local child processes/Unix socket; actual HTTP requests through direct/proxy clients.

**Independent oracle:** Literal bytes/counts, error codes, shell output, OS account database and independently observed redirect-target hit count.

**Refactor resistance:** No handler-map/CheckRedirect-hook shape; actions and externally received frames/process output remain stable through internal refactors.

**Unique protection:** Each row owns a distinct transport/lifecycle/security failure; ring arithmetic, message schemas and daemon host-side box tests cannot replace the Go process/network implementation.

**Production callers:** Agent channel opener, output pumps, detached viewers, process environment builder, daemon upload/update/auth HTTP client. **Risk/cost:** High: output loss, credential leakage and child process setup. Retain real IO; use credit/drain/ready receipts and deadlines rather than delaying every test.

**Validation target (root-scheduled; no new execution claimed):** `cd apps/box-agent && node scripts/go.mjs test -race ./internal/agent`.

| Baseline line | Exact baseline test name | Disposition | Specific contract, credible failure and surviving owner |
| ---: | --- | --- | --- |
| 54 | `TestExecOutputTailSurvivesADaemonSlowerThanTheDrainDeadline` | KEEP | A real process emits one flow-control window plus a 50 KiB tail; after withheld credit reaches the drain boundary, every byte must arrive before successful exit/close. It catches truncation under backpressure, unlike bounded-buffer or ordinary process-exit tests. |
| 135 | `TestDetachedViewerThatFallsBehindItsBufferEndsWithAnError` | KEEP | An attached detached process is made to outgrow its actual buffer while credit stalls its viewer. The channel must close with literal OUTPUT_OVERRUN. Silent byte skipping is a different failure from initial attach loss, so both owners remain. |
| 162 | `TestAttachFromADroppedOffsetReportsTheLoss` | KEEP | A real process writes literal 16 bytes into an 8-byte detached buffer, then a later attach must report droppedBytes=8. This catches an incorrect initial resume cursor/loss report; the live-viewer overrun test checks a different phase. |
| 181 | `TestProcessesNeverInheritTheTailscaleAuthKey` | KEEP | A shell launched through the real channel must print key=none despite an agent-only Tailscale auth key in the parent environment. Literal output is independent and catches secret inheritance; config parsing does not protect child-process sanitization. |
| 196 | `TestProcessesGetHomeAndUserWhenOrqAgentHasNone` | REWRITE | Reads expected home/user independently from the operating-system user database, instead of refreshSysInfo() under test, and checks a real shell receives them when the service environment lacks them. Catches broken git/CLI global-home setup; secret filtering does not test defaults. |
| 218 | `TestDaemonClientNeverFollowsRedirects` | REWRITE | Both a direct client and an explicitly configured proxy receive a real HTTP redirect; the target hit counter must remain zero. Removes CheckRedirect-hook inventory while retaining credential-forwarding protection. Either transport accidentally following redirects fails on observable network traffic. |
| 246 | `TestUnixChannelBridgesASocketInTheBox` | KEEP | A real Unix echo socket exchanges literal vnc bytes through a box unix channel. It catches broken open/data bridging or premature close; invalid-path tests prove only refusal and cannot supersede successful byte transport. |
| 277 | `TestUnixChannelRefusesARelativePathAndAMissingSocket` | REWRITE | Checks literal BAD_REQUEST for a relative path and ENOENT for a missing absolute socket, instead of accepting any open-failed. It now fails for an unrelated error; the positive socket test cannot prove these caller-visible error distinctions. |

### `apps/box-agent/internal/agent/orphan_linux_test.go`

**Independent source / real failure:** AGENTS.md process ownership rule; procstate.go durable process registry and orphan_linux.go PID/start-identity recovery/escalation; box-protocol.ts lost-process compatibility.

**Stable seam:** Actual processes, durable temporary ownership records and wire proc.list/proc.signal/attach outcomes.

**Independent oracle:** Independently started OS children, matching/mismatching recorded identities, literal LOST/exit signals and before/after file state.

**Refactor resistance:** No expected implementation call order; process liveness and durable record contents survive storage/registry refactors.

**Unique protection:** Live owner refusal, dead owner recovery, lost reattach/persistence and uncooperative escalation are different remaining failures; ordinary process shutdown tests do not cover an agent restart.

**Production callers:** Agent.prepareDataDir/recoverFrom/persistProcs and detached-process lifecycle. **Risk/cost:** High: signaling another owner/PID is destructive; all children/state are temporary and cleaned up. Actual Linux kernel behavior is necessary.

**Validation target (root-scheduled; no new execution claimed):** `cd apps/box-agent && node scripts/go.mjs test -race ./internal/agent`.

| Baseline line | Exact baseline test name | Disposition | Specific contract, credible failure and surviving owner |
| ---: | --- | --- | --- |
| 71 | `TestARestartStopsWhatThePreviousAgentLeftRunning` | KEEP | Real previous-owner processes and persisted PID/start identities verify restart recovery stops only matching leftovers, spares reused PIDs, reports LOST metadata, releases ended records and records new ownership. A PID-only kill or stale running record causes visible data/process loss. |
| 127 | `TestALiveOwnerKeepsItsProcesses` | KEEP | With a live recorded owner, actual child liveness and unchanged durable state prove another agent cannot take over or kill its processes. Dead-owner recovery exercises the opposite authorization decision and does not protect this refusal. |
| 151 | `TestDetachedProcessesAreRecordedAndALostOneCannotBeFollowed` | KEEP | Starts and ends a real detached process against the durable record, checks lost attach returns literal LOST and signaling a lost process succeeds harmlessly. It catches missing persistence, stale records or false reattach; static wire fixtures cannot prove lifecycle effects. |
| 185 | `TestALeftoverIgnoringSigtermIsKilled` | KEEP | A trap-ready real child ignores SIGTERM; bounded 100 ms grace must produce SIGKILL and the OS wait status must confirm it. This uniquely proves escalation for an uncooperative leftover; cooperative restart cleanup is insufficient. |

### `apps/box-agent/internal/agent/proc_unix_test.go`

**Independent source / real failure:** AGENTS.md preserve daemon session ownership and PTY/direct lifecycle; process interface and documented signal/group/PTY descriptor lifetime rules in proc_unix.go.

**Stable seam:** Wire signal/close and proc.signal for dispatch; process interface kill/signal/resize/release for actual OS group and descriptor behavior.

**Independent oracle:** OS child PIDs, group existence, observed process death and literal SIGTERM/SIGKILL wait status; race detector plus resize failure after release.

**Refactor resistance:** No private targets slice/type assertion remains. TestMain dispatch is fixture infrastructure, not an extra passing/skipped test.

**Unique protection:** Channel-close, signal RPC, detached registry, direct kill, moved-group fallback and concurrent descriptor release each use a distinct required entrypoint/failure; no replay at a redundant UI layer.

**Production callers:** Agent exec lifecycle, detached registry shutdown and RPC handlers call the process interface. **Risk/cost:** High: leaked processes/reused descriptors. Run with -race; child readiness and bounded liveness polling synchronize real kernel transitions, not arbitrary scenario sleeps.

**Validation target (root-scheduled; no new execution claimed):** `cd apps/box-agent && node scripts/go.mjs test -race ./internal/agent`.

| Baseline line | Exact baseline test name | Disposition | Specific contract, credible failure and surviving owner |
| ---: | --- | --- | --- |
| 236 | `TestChannelSignalEndsTheWholeProcessGroup` | KEEP | Channel signals terminate actual shell and grandchild groups across direct exec, PTY and job-control cases, with the non-PTY exit signal checked. It catches leaked descendants or lost signal dispatch; the direct process kill seam cannot cover channel routing. |
| 268 | `TestChannelCloseHangsUpTheWholeProcessGroup` | KEEP | Closing an exec channel hangs up both the real parent and grandchild. This protects channel cancellation cleanup, which an explicit signal RPC or kill() test would still pass if channel-close handling broke. |
| 276 | `TestProcSignalEndsADetachedProcessGroup` | KEEP | The distinct proc.signal RPC terminates a detached parent and child, both PTY and direct, and replies successfully. It catches registry/RPC dispatch failures that a live exec-channel signal bypasses. |
| 299 | `TestPtyCallsRacingReleaseNeverUseAClosedMaster` | REWRITE | Exercises process.signal(SIGWINCH) and resize concurrently with output close/release, instead of inspecting unixProcess.targets(). The Go race detector plus rejected post-release resize protects descriptor lifetime; group-shape changes are no longer asserted. |
| 380 | `TestKillEndsTheWholeTree` | KEEP | Direct process.kill() must SIGKILL the real child and descendants in ordinary and PTY job-control trees. Shutdown/internal cleanup uses this seam independently of signal()/channel dispatch, so a functioning remote signal path cannot supersede it. |
| 402 | `TestSignalFallsBackToThePidWhenTheGroupIsGone` | REWRITE | The child fixture is dispatched from TestMain, while the actual regression still proves its original process group is gone, sends SIGTERM through process.signal(), and observes SIGTERM from wait(). Catches a stranded process that moved groups; no private targets() expectation remains. |
| 445 | `TestHelperLeaveGroup` | DELETE | Fails real-regression and unique-protection bars: this skipped test declaration was only the subprocess fixture entrypoint, with no assertions of its own. Non-test runLeaveGroupHelper/TestMain now supplies the same real child for the surviving signal-fallback test. |

### `apps/box-agent/internal/agent/service_linux_test.go`

**Independent source / real failure:** service_linux.go ProtectService comment specifies optional needrestart integration preventing upgrades from killing sessions; literal needrestart Perl override syntax is the external file contract.

**Stable seam:** Temporary real directory/file creation through the production override writer, used by ProtectService.

**Independent oracle:** Literal service-exclusion Perl rule and absence of a directory when the optional package is not installed.

**Refactor resistance:** No production constant copied into the expected value and no mtime/write-count detail.

**Unique protection:** Only root-owned Go service tests protect orq-agent-specific override bytes/optional install; daemon deploy unit tests target orquester.service instead.

**Production callers:** ProtectService at agent startup and InstallService. **Risk/cost:** Medium: host upgrade restarts can strand sessions. Writes are restricted to test tempdirs, never /etc.

**Validation target (root-scheduled; no new execution claimed):** `cd apps/box-agent && node scripts/go.mjs test -race ./internal/agent`.

| Baseline line | Exact baseline test name | Disposition | Specific contract, credible failure and surviving owner |
| ---: | --- | --- | --- |
| 11 | `TestNeedrestartOverrideIsWrittenWhereNeedrestartIsInstalled` | REWRITE | Reads the real temporary needrestart override and requires the literal Perl service-exclusion rule, rather than comparing to needrestartOverride from production or file mtime. It catches package upgrades unexpectedly restarting orq-agent and losing sessions; write deduplication is incidental. |
| 39 | `TestNeedrestartOverrideIsSkippedWithoutNeedrestart` | KEEP | With no needrestart installation directory, ProtectService helper must leave it absent. This distinguishes optional host integration from accidental creation of an unrelated package configuration; the installed-directory case cannot catch it. |

### `apps/box-agent/internal/wire/wire_test.go`

**Independent source / real failure:** packages/api/src/box-protocol.ts is the wire source of truth; checked-in apps/box-agent/fixtures/*.json are cross-language interchange compatibility records.

**Stable seam:** Go strict JSON DecodeControl/DecodeSpec/Unmarshal and binary frame Encode/Decode public wire boundary.

**Independent oracle:** Checked-in JSON/hex from the independently typed TypeScript peer, not Go-produced expected values; expected invalid-input rejection is independent.

**Refactor resistance:** Field/key/byte compatibility survives Go identifier/helper refactors. Inventories here enumerate externally negotiated message/method kinds, not incidental exports.

**Unique protection:** Go field/null/tag/byte compatibility cannot be established by TypeScript compilation/parser tests or daemon RPC implementations. Each row covers a separate wire grammar.

**Production callers:** Go Link/RPC/channel processing and daemon TypeScript peer consume these formats/constants. **Risk/cost:** High: heterogeneous peers and rolling deployments depend on exact wire compatibility. Fixtures remain; normal validation must not set UPDATE_FIXTURES.

**Validation target (root-scheduled; no new execution claimed):** `cd apps/box-agent && node scripts/go.mjs test -race ./internal/wire`.

| Baseline line | Exact baseline test name | Disposition | Specific contract, credible failure and surviving owner |
| ---: | --- | --- | --- |
| 54 | `TestConstants` | KEEP | Compares separately implemented Go wire constants/platforms with checked-in TypeScript interchange fixtures. Wrong protocol version, credit window, frame limit or path prefix breaks interoperating peers; this is cross-language compatibility, not an export inventory. |
| 75 | `TestControlMessages` | KEEP | Strictly decodes and re-encodes literal checked-in control JSON, preserving optional/null fields and all message kinds. A renamed/dropped Go field or unrecognized control type fails even if Go code compiles; typed TS fixtures alone cannot test Go decoding. |
| 106 | `TestChannelSpecs` | KEEP | Literal channel-spec JSON is strictly decoded/re-encoded by its Go constructor and DecodeSpec must return the fixture kind. Catches wrong union dispatch, missing fields or serialization incompatibility that generic control envelopes do not inspect. |
| 169 | `TestMethods` | KEEP | Each checked-in host→box and box→host method parameter/result sample is strictly round-tripped through independently implemented Go types. Catches renamed RPC fields, incorrect result voidness and method incompatibility; handler registration tests cannot prove these values. |
| 179 | `TestDataFrames` | KEEP | Independent fixture frame hex and payload hex verify Go encoding/decoding, stream/channel values, invalid stream refusal and oversize rejection. Catches byte order or framing errors that JSON compatibility and TypeScript-only frame decoding cannot detect. |

### `apps/box-agent/src/build.test.ts`

**Independent source / real failure:** box-protocol.ts supported platform catalog; build.ts public buildBoxAgent manifest/executable contract; ELF/Mach-O/PE ABI header formats.

**Stable seam:** buildBoxAgent emitted binaries and manifest files, not its internal target mapper.

**Independent oracle:** Literal seven-target names/formats/CPU table and independent header reader plus actual file SHA-256/length; expected plan9 rejection.

**Refactor resistance:** Target mapping and compiler internals can change while emitted ABI/name/manifest behavior stays valid. Header parsing now lives in the test, not a production helper used to validate itself.

**Unique protection:** One real cross-compilation owner subsumes mapper checks and uniquely catches linker target/header/manifest mistakes. No daemon download test compiles all supported platforms.

**Production callers:** apps/box-agent/scripts/build.ts and daemon boxes/agent-build.ts use buildBoxAgent; executableName remains used for served binaries. **Risk/cost:** High compatibility risk; seven builds retained despite compiler cost. Existing static-musl reuse builds identical OS/CPU once. Go-unavailable skip is pre-existing and must be disclosed when encountered.

**Validation target (root-scheduled; no new execution claimed):** `cd apps/box-agent && TSX_DISABLE_CACHE=1 node --import tsx --test src/build.test.ts`.

| Baseline line | Exact baseline test name | Disposition | Specific contract, credible failure and surviving owner |
| ---: | --- | --- | --- |
| 14 | `goTargetFor maps every platform` | CONSOLIDATE — removed declaration | Removed owner. Fails unique-protection/stable-seam bars: inspecting exported goTargetFor and deriving expectations from platform identifiers repeats the builder mapping. Invalid-platform refusal moves into the surviving real build test; actual binary ABI and executable names now own all supported targets. |
| 23 | `every platform cross-compiles and links for its OS and CPU` | CONSOLIDATE — surviving owner | Surviving owner, strengthened. Builds all seven literal supported targets, independently reads ELF/Mach-O/PE CPU headers, checks executable names, exact platform keys, manifest version/on-disk equality and SHA-256/size from actual bytes, plus unsupported plan9 refusal. Catches wrong linker target or corrupt manifest without production mapping/format helpers. |

### `apps/box-agent/src/fixtures.test.ts`

**Independent source / real failure:** box-protocol.ts shared API and fixtures.ts documented TS↔Go golden fixture contract, with immutable normal-run fixtures/*.json.

**Stable seam:** Public API parseControlMessage/decodeDataFrame plus serialized checked-in interchange files consumed by Go.

**Independent oracle:** Handwritten typed message/payload values and independently persisted golden bytes/keys. The golden equality owner anchors encoder-generated frame examples to fixed bytes.

**Refactor resistance:** Observes wire data only; internal naming/serialization helpers may change without affecting valid protocol results.

**Unique protection:** Golden freshness, TS control acceptance and TS frame reception own different peer paths; Go decode tests cannot prove the TypeScript receiver accepts the records.

**Production callers:** Daemon box Link/parser and Go wire decoder consume the same protocol. **Risk/cost:** High compatibility importance but cheap filesystem/serialization work; retain fixture corpus, no snapshots/fixture rewrites during cleanup.

**Validation target (root-scheduled; no new execution claimed):** `cd apps/box-agent && TSX_DISABLE_CACHE=1 node --import tsx --test src/fixtures.test.ts`.

| Baseline line | Exact baseline test name | Disposition | Specific contract, credible failure and surviving owner |
| ---: | --- | --- | --- |
| 16 | `golden fixtures match the typed TypeScript values (UPDATE_FIXTURES=1 rewrites them)` | KEEP | Typed TypeScript samples must equal checked-in interchange JSON consumed by Go; UPDATE_FIXTURES is an explicit opt-in, not part of validation. Catches unintentional wire-byte/key drift across versions, independently of whether current encoder and decoder agree with one another. |
| 26 | `every control fixture parses as a control message of its type` | KEEP | Each typed control sample must be accepted by the public TypeScript parser as its literal message kind. Catches valid handshake/control variants rejected by the daemon parser; Go strict decoding protects a separate peer implementation. |
| 36 | `frame fixtures decode back to their payloads` | KEEP | Public TypeScript frame decoding must recover independently supplied channel, stream and payload values for the shared fixture examples. Catches mismatched sender/receiver framing; fixed on-disk golden bytes prevent a mutually incorrect encoder/decoder from silently redefining the protocol. |

### `apps/desktop/src/http-stream.test.ts`

**Independent source / real failure:** http-stream.ts documents exact single stream termination and error-status/no-body forwarding; main.ts embedded and remote stream bridges; stream-status.ts consumes those status codes.

**Stable seam:** pipeHttpStream sink receives bytes/end from real Node HTTP/Unix IncomingMessage and request refusal.

**Independent oracle:** Literal emitted event/all bytes, zero body data for 401, exactly one end with literal status/undefined.

**Refactor resistance:** Assertions ignore socket/handler implementation; same response branch justifies dropping duplicate TCP cut and Unix status runs.

**Unique protection:** Successful data, pre-response connection failure, mid-response Unix daemon restart and HTTP error status are distinct. Renderer status interpretation is retained separately because it is another protocol boundary.

**Production callers:** main.ts local Unix and remote HTTP streaming bridge handlers. **Risk/cost:** Medium: hangs/double-end/auth retries; loopback listeners and temp sockets only, deterministic firstData before interruption.

**Validation target (root-scheduled; no new execution claimed):** `cd apps/desktop && TSX_DISABLE_CACHE=1 node --import tsx --test src/http-stream.test.ts`.

| Baseline line | Exact baseline test name | Disposition | Specific contract, credible failure and surviving owner |
| ---: | --- | --- | --- |
| 50 | `a response the server cuts mid-body ends the stream once` | CONSOLIDATE — removed declaration | Removed duplicate. The surviving Unix-socket daemon-restart case exercises the same pipeHttpStream IncomingMessage close/error handling after received bytes and checks exactly one end. TCP versus socket setup adds no separate response-handling branch. |
| 66 | `a clean end ends the stream once` | KEEP | A real successful HTTP response delivers literal all newline bytes and ends once. This catches lost normal data or duplicate end notifications; aborted/error responses are distinct failure paths and cannot supersede normal completion. |
| 78 | `an error answer reports its status once and never its body` | CONSOLIDATE — surviving owner | Surviving error owner. A real HTTP 401 produces exactly end(401) and no body data, protecting renderer stream authentication handling. The removed Unix 404 case used the same IncomingMessage status branch; the bridge-status test separately owns IPC interpretation. |
| 90 | `a request that cannot connect ends the stream once` | KEEP | A request to an actually closed local listener must end once. It catches connection refusal leaving a subscriber hanging, before any IncomingMessage exists; response completion/abort cases cannot cover it. |
| 115 | `over the unix socket: a daemon restart cutting the stream ends it once` | CONSOLIDATE — surviving owner | Surviving interruption owner. After actual event bytes arrive over the embedded-daemon Unix socket, destroying the response must preserve those bytes and end once. It catches a hanging/double-ended stream on restart and supersedes the equivalent TCP cut-body execution. |
| 131 | `over the unix socket: an error answer reports its status, never its body as data` | CONSOLIDATE — removed declaration | Removed duplicate. The retained real HTTP error-status owner checks status forwarding and absence of body bytes for the same IncomingMessage branch; Unix connection creation is separately covered by the retained restart case. |

### `apps/desktop/src/menus.test.ts`

**Independent source / real failure:** Electron semantic MenuItem roles and accelerators; menus.ts documented macOS system shortcuts and ContextMenuActions; main.ts installs templates/callbacks.

**Stable seam:** Native menu template contract passed to Electron, using roles/enabled state and invoked command callbacks.

**Independent oracle:** Literal native role names, supplied capability flags and observable settings/logs/replacement/dictionary callbacks.

**Refactor resistance:** Removes label/separator trees and most positions; native roles/accelerators and action data survive presentation/order refactors.

**Unique protection:** No browser test can verify main-process menu command routing. macOS/Windows branches and editable/selection/spelling contexts have distinct callers/failures.

**Production callers:** main.ts Menu.setApplicationMenu and webContents context-menu listener. **Risk/cost:** Low runtime cost, meaningful desktop usability risk. Spelling suggestion labels are caller data, not exact product-copy requirements.

**Validation target (root-scheduled; no new execution claimed):** `cd apps/desktop && TSX_DISABLE_CACHE=1 node --import tsx --test src/menus.test.ts`.

| Baseline line | Exact baseline test name | Disposition | Specific contract, credible failure and surviving owner |
| ---: | --- | --- | --- |
| 19 | `on macOS: an app menu with Settings… and quit, then File, Edit, View, Window and Help` | REWRITE | Now provides native shortcuts and routes Settings/log actions on macOS. Finds Electron native roles and the Settings accelerator, invokes callbacks and checks their destinations. Removes exact menu/label/separator order; catches broken OS edit/view shortcuts or commands without snapshotting presentation. |
| 71 | `elsewhere: Settings… and Quit live in File, and Edit has no Speech` | REWRITE | Now provides the Settings shortcut and Quit on Windows. Requires a real quit role and invokes the Settings accelerator action, without enforcing File/Edit/Speech ordering or wording. Catches inaccessible Settings/quit commands; macOS exercises a different template branch. |
| 98 | `offers cut, copy, paste and select all in an editable field, enabled as the field allows` | REWRITE | Checks cut/copy disabled and paste/select-all enabled by the supplied Electron edit flags, locating actions by semantic role. Removes ordered label-tree assertions. Catches clipboard actions enabled against native capability or valid actions disabled; app-menu roles do not test context state. |
| 104 | `puts up to five spelling suggestions and Add to Dictionary first over a misspelled word` | REWRITE | Now invokes a suggested replacement and Add to Dictionary and checks literal replace:the/add:teh actions. Removes suggestion-count/position/copy assertions. Catches wrong selected word or dictionary target; ordinary edit-menu roles cannot cover spelling callbacks. |
| 135 | `offers Copy over a selection outside a field, and nothing over plain page` | REWRITE | Requires Copy for a non-editable selection and an empty menu for whitespace/plain page, instead of exact incidental menu trees. Catches lost text-copy affordance or unwanted page interception; editable-field cases protect a different context. |

### `apps/desktop/src/native-notifications.test.ts`

**Independent source / real failure:** AGENTS.md validate bridge payloads; native-notifications.ts NotificationTarget/NotificationRequest and replacement/release and finite hold contract; main.ts native IPC handlers.

**Stable seam:** Untrusted payload parsers and NotificationRegistry public hold/release returns with native Node mock time.

**Independent oracle:** Literal valid/invalid IPC values and tags/targets; hold previous-item identities; native virtual-clock completion of pending timers; no assertion freezes the lifetime tuning.

**Refactor resistance:** No bitmap/copy snapshot, exported cap, held-map size or custom timer collaborator protocol. Functional outcomes remain across storage/timer refactors.

**Unique protection:** Payload refusal, accepted targets, numeric badge validation, replacement ownership and release/expiry each catch a different failure; UI notification decisions do not validate the privileged main boundary.

**Production callers:** main.ts orquester:notify/orquester:badge and Notification click/close/failed handlers. **Risk/cost:** High input/navigation safety; native mock timers avoid waiting/lingering real 30-minute handles. Removed exact appearance/copy assertions have no independent requirement.

**Validation target (root-scheduled; no new execution claimed):** `cd apps/desktop && TSX_DISABLE_CACHE=1 node --import tsx --test src/native-notifications.test.ts`.

| Baseline line | Exact baseline test name | Disposition | Specific contract, credible failure and surviving owner |
| ---: | --- | --- | --- |
| 14 | `accepts what the renderer sends, trimming and capping the text` | REWRITE | Now checks accepted session/workflow targets, null target, title trimming and malformed optional run-id degradation using literal payloads. Removes arbitrary title/body length expectations. Catches a valid notification being lost or opening the wrong target at the renderer→main boundary. |
| 43 | `refuses anything else` | KEEP | Literal malformed IPC values, wrong field types, invalid tags and unsafe/unknown target shapes must be refused. Catches untrusted renderer data reaching native notifications or arbitrary navigation; accepted-payload tests cannot protect this validation boundary. |
| 65 | `takes a whole, non-negative count and caps it` | REWRITE | Now uses literal accepted counts and rejects negative, fractional, nonfinite or nonnumeric values, without computing an expected cap from BADGE_MAX. Catches malformed renderer badge state reaching OS APIs; the arbitrary presentation cap is not independently specified. |
| 74 | `describes the Windows overlay for a screen reader` | DELETE | Fails independent-contract/refactor bars: exact singular/plural accessibility wording has no specified copy requirement. Production badgeDescription remains because main.ts uses it; payload validation protects valid attention counts, not a particular sentence. |
| 80 | `draws the overlay as a premultiplied BGRA red dot with transparent corners` | DELETE | Fails independent-contract/refactor bars: asserts exact red pixels, corners, dimensions and premultiplication of the current drawing with no visual regression requirement. Production bitmap generation remains used by Electron; no meaningful payload or notification-routing behavior is removed. |
| 120 | `replaces a notification with the same tag and hands back the old one to close` | REWRITE | Uses native virtual timers and public hold() return values: replacing a tag returns its previous item, and late release of the old item cannot discard its replacement. Removes injected timer protocol and size inventory; catches lost click handlers on notification replacement. |
| 132 | `lets go on click, close or failure, and on its own once the hold lapses` | REWRITE | Runs pending native virtual timers and observes hold() outcomes to prove explicit release and eventual expiry for distinct tags. Removes custom lifetime/timer fakes and internal size checks; catches leaked holds or premature retention after release. |

### `apps/desktop/src/navigation.test.ts`

**Independent source / real failure:** AGENTS.md secrets stay on daemon and remote auth boundaries; navigation.ts documented URL trust/base/custom-scheme contract; ApiClient DevTools wire URL producer.

**Stable seam:** Pure navigationAction/windowOpenAction/visualTarget decisions consumed by Electron event/protocol handlers.

**Independent oracle:** Literal action targets/denials and expected path/origin boundaries; real ApiClient generates a credential-bearing URL only as adversarial input, not the expected action.

**Refactor resistance:** Tests validate trust decisions and public protocol paths rather than private call shape or incidental identifier names.

**Unique protection:** Separate normal navigation, window.open, daemon base registration and orq-visual routes require their own entrypoint protection; daemon route auth does not prevent main-process credential exfiltration.

**Production callers:** main.ts will-navigate/setWindowOpenHandler, remote base registration and custom orq-visual protocol handling. **Risk/cost:** High security risk; pure tests are cheaper and more deterministic than launching Electron/system browsers.

**Validation target (root-scheduled; no new execution claimed):** `cd apps/desktop && TSX_DISABLE_CACHE=1 node --import tsx --test src/navigation.test.ts`.

| Baseline line | Exact baseline test name | Disposition | Specific contract, credible failure and surviving owner |
| ---: | --- | --- | --- |
| 28 | `are read off the paths the client appends to its endpoint` | KEEP | Literal API/session and health URLs yield their configured daemon bases, including sub-paths; unrelated routes and file URLs do not. Catches trust records that authorize the wrong origin/path before download decisions; downstream cases cannot enumerate base discovery inputs. |
| 38 | `stays on the app's own document, whatever its fragment` | KEEP | Allows only the app document plus fragment, including the development origin, and rejects another local file. Catches renderer navigation escaping the installed document; external-link routing deliberately has a separate allow policy. |
| 44 | `downloads a remote's file itself, so the token reaches only that daemon` | KEEP | Known root and sub-path daemon download URLs produce download actions carrying their original token only to that daemon. Catches authenticated downloads sent to a browser or denied; negative unknown-base tests do not establish the valid flow. |
| 51 | `downloads only at a remote's configured base, never another prefix on its origin` | KEEP | Literal wrong prefixes on a known daemon origin must be denied. Catches an origin-only allowlist leaking a credential to another application at that host; positive configured-base downloads cannot detect overbroad trust. |
| 61 | `never hands a URL with a credential to the system browser, however nested` | KEEP | Real ApiClient DevTools URLs and literal nested/query/fragment/userinfo credentials must never become external browser links for either navigation entrypoint, while innocuous queries remain allowed. Catches credential exfiltration across encoding/nesting forms; ordinary external-link tests have no secrets. |
| 84 | `refuses a value nested past the unwrapping bound` | KEEP | Deeply encoded token-bearing input must fail closed beyond the bounded unwrap depth. Catches bounded scanning incorrectly treating unexamined input as safe; shallower recognized credential shapes cannot protect exhaustion behavior. |
| 90 | `sends an ordinary link to the system browser and refuses other schemes` | KEEP | Literal ordinary HTTPS/mailto links are external, while javascript/data/local-file schemes are denied. Catches unsafe URL execution or broken normal linking; credential-denial tests alone could pass an implementation that denies every URL. |
| 104 | `a window.open of a remote download is downloaded too` | KEEP | A window.open download uses the authenticated download action. Catches pop-up routing bypassing the normal-navigation download policy; the other positive-download test enters navigationAction, not this separate public entrypoint. |
| 113 | `names the local daemon's page by path` | KEEP | Literal orq-visual://local page URLs resolve only the permitted local visual path; fs.download is rejected. Catches custom-scheme escalation to arbitrary local daemon routes; remote visual routing uses a different address form. |
| 118 | `names a remote's page at its base, keeping a daemon's sub-path` | KEEP | Literal registered remote visual URLs preserve root/sub-path endpoints and the signed page path. Catches a visual routed to the wrong daemon or stripped prefix; rejection cases cannot prove successful page loading. |
| 129 | `refuses an unknown remote, another prefix on a known origin, a non-page route, or more than a path` | KEEP | Unregistered origins, wrong prefixes, userinfo/query-bearing endpoints, non-page routes and non-custom schemes resolve to null. Catches custom-scheme remote credential/route escalation; ordinary download/navigation guards are separate callers. |

### `apps/desktop/src/transport/stream-status.test.ts`

**Independent source / real failure:** stream-status.ts bridge end/status documented contract; AGENTS.md validates IPC before UI state; 401 revocation must stop stream retry.

**Stable seam:** endBridgeStream public renderer-side callback boundary.

**Independent oracle:** Literal callback order, numeric status metadata and malformed values; no exact generated error wording.

**Refactor resistance:** Independent of Error text and main-process internals.

**Unique protection:** Node HTTP status forwarding and renderer IPC interpretation can fail separately; these four cases partition explicit error, normal end, malformed input and omitted optional handler.

**Production callers:** DesktopTransport bridge stream end handling. **Risk/cost:** Medium: authentication retry/hanging consumer behavior, negligible pure-function cost.

**Validation target (root-scheduled; no new execution claimed):** `cd apps/desktop && TSX_DISABLE_CACHE=1 node --import tsx --test src/transport/stream-status.test.ts`.

| Baseline line | Exact baseline test name | Disposition | Specific contract, credible failure and surviving owner |
| ---: | --- | --- | --- |
| 15 | `a status-reported end is an error carrying the status, then the end` | KEEP | Integer 401/503 bridge statuses produce onError carrying that exact status before onEnd. Catches revoked streams retrying indefinitely because authentication failure was erased; main-process HTTP tests stop before renderer callback interpretation. |
| 20 | `a plain end (a clean one, or a stream the daemon cut) is only the end` | KEEP | Undefined/200 status produces only onEnd. Catches clean/restarted streams becoming false authorization failures; explicit error-status coverage cannot protect normal reconnect behavior. |
| 25 | `a malformed status from the bridge is a plain end` | KEEP | Literal malformed bridge statuses produce a plain end, not a fabricated HTTP error. Catches invalid IPC payloads causing UI failure handling; numeric valid statuses do not test boundary validation. |
| 31 | `a consumer without onError still gets its end` | KEEP | A valid error status still invokes onEnd when onError is omitted. Catches older/minimal consumers hanging or throwing on optional callbacks; other cases always install the error handler. |

### `apps/desktop/src/window-lifecycle.test.ts`

**Independent source / real failure:** window-lifecycle.ts documented titlebar-rebuild lifecycle: old window stays visible until replacement ready; hidden-to-tray stays hidden and messages wait.

**Stable seam:** Pure lifecycle plans and RendererOutbox push/drain results used by main.ts.

**Independent oracle:** Literal create/wait/show decisions, visibility state and FIFO one-shot payload sequence.

**Refactor resistance:** No Electron collaborator call-count expectation, injected outbox cap or private size inventory.

**Unique protection:** User show requests, replacement visibility, delivery eligibility and queued message ordering can fail independently; no safe browser/Electron integration provides stronger required coverage.

**Production callers:** main.ts createWindow/showWindow and renderer dispatch/outbox logic. **Risk/cost:** Medium: lost notification clicks or extra windows. Pure tests avoid launching Electron while preserving state-machine outcomes.

**Validation target (root-scheduled; no new execution claimed):** `cd apps/desktop && TSX_DISABLE_CACHE=1 node --import tsx --test src/window-lifecycle.test.ts`.

| Baseline line | Exact baseline test name | Disposition | Specific contract, credible failure and surviving owner |
| ---: | --- | --- | --- |
| 7 | `brings the window on screen forward, mid-rebuild too, instead of opening a third` | KEEP | Literal visible-main/rebuild states must choose show-main. Catches a tray/second-launch request creating a third window while a replacement loads; no-main cases cannot expose duplicate creation when the old window still exists. |
| 12 | `creates a window only when there is none and none is on its way` | KEEP | Without a main window, chooses create normally but wait during replacement startup. Catches a hidden unusable app or a second concurrent replacement; existing-window cases use a different state. |
| 17 | `lets the replacement show only in place of a window that was showing` | KEEP | Only a visible, non-destroyed original lets its replacement show. Catches a titlebar change exposing an app hidden to tray or resurrecting a destroyed window; show-window routing does not determine replacement visibility. |
| 25 | `go only to a loaded main page, and wait out a rebuild for the replacement` | KEEP | Renderer delivery requires a loaded main page outside rebuild. Catches notification/deep-link messages delivered into a soon-destroyed page; the outbox test establishes storage order, not when delivery is permitted. |
| 31 | `queue in order, drain once, and drop the oldest past the cap` | REWRITE | Now uses the production default outbox and checks literal FIFO messages then an empty second drain. Removes custom capacity/size exposure. Catches reordered or duplicate one-shot notifications; the exact overflow cap was an incidental implementation choice. |

### `apps/desktop/src/window-state.test.ts`

**Independent source / real failure:** WindowState persisted JSON contract and window-state.ts documented monitor removal/centering/native-frame behavior; user Custom titlebar setting consumed by main.ts/preload.

**Stable seam:** parseWindowState, resolveInitialWindowBounds and frame/native-control options passed to BrowserWindow.

**Independent oracle:** Literal saved/invalid data, explicit screen arrangements, absence of x/y for Electron centering and native frame options.

**Refactor resistance:** Persisted placement and OS control semantics remain; removes defaults imported as their own oracle, arbitrary minimum/traffic-light coordinates and write-dedup details.

**Unique protection:** Parsing tolerance, maximized persistence, negative/multiple/disconnected displays and OS-specific native controls are independent startup failures; lifecycle tests do not validate persisted coordinates.

**Production callers:** main.ts window-state load/save, BrowserWindow construction and frame rebuilding; preload consumes the native-controls argument. **Risk/cost:** Medium: off-screen windows are a critical usability failure. Geometry retained only for saved visibility/placement, not incidental appearance.

**Validation target (root-scheduled; no new execution claimed):** `cd apps/desktop && TSX_DISABLE_CACHE=1 node --import tsx --test src/window-state.test.ts`.

| Baseline line | Exact baseline test name | Disposition | Specific contract, credible failure and surviving owner |
| ---: | --- | --- | --- |
| 20 | `reads saved bounds and the maximized flag` | KEEP | Literal saved position/size and maximized=true survive parsing. Catches loss of persisted window state; invalid-record and multi-monitor placement tests do not test parsing of the maximized field. |
| 27 | `grows a size below the window minimum, and keeps negative positions (a display left of the primary)` | REWRITE | Now checks valid negative saved coordinates for a monitor left/above the primary; removes an expected minimum size imported from production. Catches falsely rejecting legitimate multi-monitor persistence without prescribing arbitrary minimum geometry. |
| 34 | `degrades a file from another version, or garbage, to the defaults field by field` | REWRITE | Uses explicit empty-state literals and field-wise malformed persistence examples instead of DEFAULT_WINDOW_STATE. Catches corrupted/older records crashing startup, accepting unsafe dimensions or losing a valid maximized flag; valid roundtrip alone cannot protect tolerance. |
| 52 | `compares states for a skipped write` | DELETE | Fails independent-contract/real-visible-outcome bars: compares private saved-state values solely to skip a write, with no persistence-loss or write-amplification requirement. sameWindowState remains a production-used optimization; saved-state parsing/restoration owners remain. |
| 63 | `restores bounds that fit on any connected display` | KEEP | Literal bounds fully on the primary or another connected display must be restored unchanged. This geometry is the persisted user placement contract, not incidental appearance; catches incorrectly recentering every restart and is distinct from absent-monitor recovery. |
| 74 | `centres the saved size on the primary display when its monitor is gone` | KEEP | When the saved monitor disappears but its size fits the primary, returns that literal size without x/y so Electron centers it. Catches reopening off-screen or losing usable size; an on-screen restoration case cannot protect disconnected displays. |
| 81 | `falls back to the default size when the saved one fits nowhere, nothing was saved, or no display is known` | REWRITE | Checks positive fallback dimensions and omission of x/y for unusable/missing records or no displays, plus recentering a straddling window. Removes production DEFAULT_WINDOW_SIZE equality. Catches invisible startup while permitting behavior-preserving default-size changes. |
| 94 | `keeps macOS's hidden titlebar with traffic lights whatever the setting` | REWRITE | Checks macOS hidden titlebar/native controls and identical frame identity across the custom-titlebar setting, without fixed traffic-light coordinates. Catches disappearing OS controls or unnecessary window replacement; Windows/Linux follow a separate platform contract. |
| 103 | `gives Windows and Linux the OS frame and its buttons when the custom titlebar is off` | KEEP | Literal Windows/Linux native versus custom frame options, changed frame identity and native-control visibility follow the user setting. Catches duplicate/missing window buttons or failure to rebuild; macOS deliberately keeps the same native-control policy. |

### `apps/web/test/sw.test.mjs`

**Independent source / real failure:** public/sw.js documented offline cache policy, cached-shell pinning, network fallback and session/workflow push deep-link protocol; daemon push payload producers and UI deep-link consumers.

**Stable seam:** Classic worker functions/event handlers executed in VM with cache/fetch/client platform fakes that store actual values and controlled network/timer completion.

**Independent oracle:** Literal HTML/assets, response bodies, IDs/query URLs/messages, observed event waits and cache state. Fakes do not implement the worker policy asserted.

**Refactor resistance:** No asset-cap threshold, number-of-cache-opens or exact timeout constant; wire paths and asynchronous visible outcomes survive worker refactors.

**Unique protection:** Pinning/eviction, target calculation, push retention, click dispatch and four network states each catch distinct failures; UI link parsing cannot prove browser worker lifecycle.

**Production callers:** Browser service-worker fetch/push/notificationclick events; UI reads links/messages, daemon emits push IDs. **Risk/cost:** High offline/push reliability, inexpensive VM seam. Native network/browser startup is unnecessary for these protocol outcomes; smoke owns built SPA startup separately.

**Validation target (root-scheduled; no new execution claimed):** `node --test apps/web/test/sw.test.mjs`.

| Baseline line | Exact baseline test name | Disposition | Specific contract, credible failure and surviving owner |
| ---: | --- | --- | --- |
| 51 | `trims the oldest assets past the limit but never the shell's own` | KEEP | A literal cached HTML shell pins its entry/preload/style asset paths while overflow removes oldest unrelated assets. Catches offline blank screens after lazy-chunk eviction; under-limit/count declaration checks cannot prove retained executable resources. |
| 75 | `without a cached shell, trims oldest first as before` | KEEP | With no cached shell, a literal insertion-ordered asset set evicts the oldest overflow. Catches cache growth/stale-entry retention when a shell is missing; pinning coverage assumes a valid shell and protects a different fallback. |
| 84 | `does not read the shell while the cache is under the limit` | DELETE | Fails stable-seam/refactor and unique-protection bars: asserts shell-cache open call count below the limit rather than offline/resource behavior. Retained trimming outcomes protect data, and no independently required number of cache reads exists. |
| 98 | `has room for the lazy diagram and math chunks beside the app` | DELETE | Fails independent-oracle/real-regression bars: only asserts the current ASSET_CACHE_LIMIT constant is at least 150. It never loads the built lazy chunks; actual shell pinning and overflow behavior remain. |
| 133 | `a session's opens that session's tab` | KEEP | Literal valid session data yields its session query URL and open-session message. Catches tapping an agent notification opening the wrong tab; workflow and window-focus tests have separate target/dispatch responsibilities. |
| 141 | `a workflow run's opens the run, as before` | KEEP | Literal workflow/run IDs yield encoded workflow/run query and the open-workflow-run message. Catches lost run identity or session misrouting; session targeting is a different wire payload. |
| 150 | `anything else (the test push, a malformed id) just opens the app` | KEEP | Missing or malformed notification IDs yield the app root and no navigation message. Catches arbitrary/unsafe deep links or a failed generic notification; valid targets cannot protect input rejection. |
| 157 | `an open window is focused and told which session to open` | KEEP | With an existing client, dispatches the literal session message and focuses that window without opening another. Catches lost in-app notification navigation or duplicate windows; no-client behavior takes another platform API path. |
| 167 | `with no window open, a new one starts on the session's link` | KEEP | With no clients, opens the literal session link in a new window. Catches taps doing nothing when the PWA is closed; existing-client focus cannot exercise openWindow. |
| 174 | `the click handler closes the notification and waits for the window` | KEEP | Invokes the registered notificationclick handler, proving it closes the native notification and awaits client focus/navigation. Catches missing event wiring or premature worker teardown; helper target calculations alone cannot prove the registered event runs. |
| 191 | `a push keeps the session, workflow and run ids for the tap` | KEEP | Invokes the actual push handler and checks independent session/workflow/run identifiers in showNotification data. Catches target IDs dropped before the later click; click-only tests handcraft already-present data. |
| 250 | `answers from the network when it comes in time, and caches the shell` | KEEP | A controlled network response wins before timeout and the resulting literal HTML is stored as /index.html. Catches always-stale loads or missing offline refresh; timeout/offline fallback cases cannot prove the normal update path. |
| 261 | `serves the cached shell once the timeout passes, and still caches the late answer` | REWRITE | Still proves cached HTML answers when controlled time expires and the late real fetch result refreshes /index.html. Drops exact 3500 ms equality; this uniquely catches a bad link hanging startup or a late refresh being lost, while allowing delay tuning. |
| 280 | `without a cached shell, waits on the network past the timeout` | KEEP | Without a shell, expiring the controlled timeout must keep waiting until the real pending network response arrives. Catches returning undefined/blank error merely because the cache is cold; cached fallback assumes an available response. |
| 293 | `offline, answers the cached shell, or a network error without one` | KEEP | An actual rejected fetch returns cached shell or Response.error() on cache miss. Catches respondWith receiving undefined and breaking offline startup; a pending bad link and an outright network rejection take distinct asynchronous paths. |

### `deploy/lib/remote-update.test.mjs`

**Independent source / real failure:** deploy/README.md Deploy health check and automatic revert; remote-update.sh documented exit codes/RESET_REF/AUTO_REVERT and durable last-success commit semantics.

**Stable seam:** Actual Bash process and throwaway Git checkout+bare origin; external installer/health/systemd commands stubbed with observable results to avoid touching the live host.

**Independent oracle:** Literal exits 0/1/3/4, actual Git commit identities, persisted stamp/marker and recorded restart history driven by independent success/failure inputs.

**Refactor resistance:** Tests permit internal shell helper/variable refactors; they observe released commit, health disposition and host effects, not source command grep.

**Unique protection:** Seven scenarios own distinct deployment failure/recovery states including a two-deployment history. Unit helpers cannot establish safe checkout/build/restart ordering and durable rollback selection.

**Production callers:** deploy.sh deploy/rollback invokes this remote payload. **Risk/cost:** High: a bad gate causes downtime. Retain real Git/Bash integration; isolated stubbed health avoids real retry windows and external network. No real deployment is performed.

**Validation target (root-scheduled; no new execution claimed):** `node --test deploy/lib/remote-update.test.mjs`.

| Baseline line | Exact baseline test name | Disposition | Specific contract, credible failure and surviving owner |
| ---: | --- | --- | --- |
| 130 | `a healthy release deploys, records itself and prints its version and commit` | KEEP | Runs the actual Bash payload against temporary Git/origin and stubbed host commands; verifies release HEAD, version/commit stamp, successful-deploy marker and exactly one restart. Catches success being reported for the wrong release; failure cases cannot prove durable success state. |
| 144 | `an unhealthy release is rolled back to the previous one, which is restarted and healthy; the deploy fails` | KEEP | A newly unhealthy release must restore the previous durable release, rebuild/restart it, preserve its success marker and exit 3. Catches deploying a dead daemon or falsely reporting success after revert; healthy deployment has no rollback path. |
| 160 | `when the previous release does not come back either, the deploy fails loudly with its own code` | KEEP | If both new and previous releases fail health, exit 4 and checked tree/restart history expose the rollback failure. Catches treating a down service as safely restored; successful auto-revert deliberately ends healthy. |
| 170 | `AUTO_REVERT=0 leaves the unhealthy release in place and fails` | KEEP | AUTO_REVERT=0 must leave the unhealthy new commit in place, restart only once and exit 1. Catches a disabled rollback unexpectedly replacing a release; default rollback must do the opposite. |
| 179 | `a failed build never restarts the daemon` | KEEP | A failed real-script build step must keep the running daemon untouched, with zero restart calls and a failed exit. Catches downtime caused by restarting into an incomplete build; health failures occur only after a successful build. |
| 189 | `the manual rollback to a sha still works, and a later unhealthy deploy reverts to it` | KEEP | An explicit RESET_REF rollback to a SHA becomes the durable successful release, and a later unhealthy deploy reverts to it. Catches using the current checkout/branch instead of last-success state across deployments; a single fresh deploy cannot detect that history dependency. |
| 203 | `an unknown ref fails before touching the tree` | KEEP | An unknown target ref must fail while HEAD and restart history remain unchanged. Catches destructive checkout/restart before validation; build failures assume the requested commit exists. |

### `scripts/check-changed.test.mjs`

**Independent source / real failure:** AGENTS.md pnpm check:changed contract and script JSDoc: sibling selection, dependent typechecks, each package runner/setup/limits, root last and standalone checks.

**Stable seam:** Exported planning/quoting functions that directly determine shell commands the CLI executes.

**Independent oracle:** Handwritten file tree and literal selected paths, pnpm arguments and POSIX command strings, never production planner output used as expectation.

**Refactor resistance:** OS/shell argument bytes and documented planning results are the seam, not local helper names or source greps.

**Unique protection:** Selection, path ownership, runner extraction, command assembly, dependent typecheck filters and shell quoting fail independently. Integration suite execution cannot prove an omitted changed-file check should have run.

**Production callers:** scripts/check-changed.mjs main, reached by root pnpm check:changed. **Risk/cost:** Medium: silent validation gaps or filename shell parsing. Pure planning tests avoid full typecheck/test subprocesses.

**Validation target (root-scheduled; no new execution claimed):** `node --test scripts/check-changed.test.mjs`.

| Baseline line | Exact baseline test name | Disposition | Specific contract, credible failure and surviving owner |
| ---: | --- | --- | --- |
| 28 | `selectTests: changed tests, and the tests and checks beside a changed file` | KEEP | A literal fake repository tree and changed-file list yield independently enumerated sibling tests/checks while excluding similar prefixes. Catches silently omitted regression targets or unrelated work; command planning accepts an already selected list. |
| 55 | `selectTests: a deleted test is skipped; a deleted source still selects its sibling test` | KEEP | A deleted test is omitted, but a deleted production file still selects its surviving sibling; missing directories are tolerated. Catches CI failure on removed paths or missed deletion regressions; normal-tree selection cannot expose absent entries. |
| 60 | `packageOf picks the package that contains a path, or null` | KEEP | Literal exact-directory paths resolve to the correct workspace and similar prefixes/root paths do not. Catches running checks in the wrong package; downstream plans do not cover these boundary/path values. |
| 66 | `runnerOf takes the package's own node --test preamble` | REWRITE | Checks literal runner commands including timeout/concurrency retention, setup prefix, and removal of test flags for checks. Removes expectations derived via runnerOf itself. Catches focused checks losing native preparation or passing --test flags to standalone scripts. |
| 81 | `planTests groups files per package with its runner, root last, and reports unrunnable ones` | REWRITE | Expected package groups and shell commands are literal, including quote escaping, root-last ordering, standalone checks and unrunnable files. Removes production-generated runner expectations. Catches wrong cwd/quoting/dispatch even if runner parsing alone works. |
| 101 | `planTypecheck: affected packages and dependents, all for a root input, none otherwise` | KEEP | Literal changes yield pnpm filters for affected packages plus dependents, all packages for root config, and none for unrelated files. Catches skipped dependent typechecks or unnecessary broad work; test selection protects a different gate. |
| 111 | `shellQuote survives quotes and spaces` | KEEP | Literal POSIX quoting for spaces and embedded apostrophes protects generated shell operands. Catches a valid filename breaking/executing shell syntax; planTests contains one integrated apostrophe example but no separate whitespace operand, so this is the lowest focused escaping owner. |

### `scripts/deploy-public-url.test.mjs`

**Independent source / real failure:** deploy/README.md public origin env contract and ensure-public-url.sh documented existing-value preservation, optional domain, safe env-file writes and mode 0600.

**Stable seam:** Actual helper Bash execution against temporary env files.

**Independent oracle:** Literal file bytes/public URL and stat mode, unchanged bytes on preserve/refusal; statuses are independently expected.

**Refactor resistance:** Source command-layout inspection removed; shell implementation can change while output config remains compatible.

**Unique protection:** Three surviving cases own add/preserve/refuse configuration outcomes. remote-update tests own deployment orchestration, not domain-env mutation details.

**Production callers:** remote-update.sh and remote-provision.sh prepare public addressing for boxes. **Risk/cost:** High configuration/privacy significance, cheap local subprocess/filesystem work. Provisioning itself is not an E2E-validated workflow in this scope.

**Validation target (root-scheduled; no new execution claimed):** `node --test scripts/deploy-public-url.test.mjs`.

| Baseline line | Exact baseline test name | Disposition | Specific contract, credible failure and surviving owner |
| ---: | --- | --- | --- |
| 26 | `adds ORQUESTER_PUBLIC_URL from the domain when the file has none` | KEEP | Actual Bash execution appends the literal HTTPS public origin, handles a missing final newline, remains idempotent and preserves mode 0600. Catches invalid env files, lost daemon addressing or exposed secrets; source command greps cannot prove file behavior. |
| 42 | `never overwrites an existing value` | KEEP | Actual existing and explicitly empty ORQUESTER_PUBLIC_URL values remain byte-for-byte unchanged. Catches deployment overwriting an operator override; adding a missing key follows the opposite configuration rule. |
| 51 | `does nothing without a domain, and refuses a domain that could inject` | KEEP | An empty domain leaves the real file unchanged, and shell-syntax input fails without mutation. Catches unintended config writes or unsafe target-domain acceptance; valid-domain insertion cannot protect refusal. |
| 60 | `the deploy and provision payloads run it with the target's domain` | DELETE | Fails stable-seam/refactor and real-regression bars: source regexes require a particular helper command/variable layout in deploy/provision payloads, plus repeated syntax probes. Runtime env-file behavior remains above; deploy payload behavior is exercised by remote-update tests, without claiming full provision E2E coverage. |

### `scripts/ensure-node-native.test.mjs`

**Independent source / real failure:** deploy/README.md native ABI guard before service restart and desktop build --detach shared-store protection; ensure-node-native.mjs documented load-probe authority/rebuild-one-batch semantics.

**Stable seam:** Guard/CLI outcome plus external rebuild side effect; real child probe and real hardlinked files for boundaries the decision fakes intentionally isolate.

**Independent oracle:** Independent scripted load outcomes, literal rebuilt names/exit codes, actual child module failure and file contents/inodes/modes after a write.

**Refactor resistance:** No static module-list inventory; assertions follow observable rebuild work/loadability/isolation rather than source layout.

**Unique protection:** No-op/one/multiple failure, still-broken and misleading installer status are different decisions; child-process and pnpm hardlink behavior cannot be proven by injected decision probes.

**Production callers:** Daemon package test setup, deploy payloads and desktop build:electron run the guard; --detach precedes electron-builder. **Risk/cost:** High native startup/shared-store reliability; decision tests avoid actually rebuilding dependencies, and hardlink mutation stays inside a tempdir.

**Validation target (root-scheduled; no new execution claimed):** `node --test scripts/ensure-node-native.test.mjs`.

| Baseline line | Exact baseline test name | Disposition | Specific contract, credible failure and surviving owner |
| ---: | --- | --- | --- |
| 29 | `does nothing when every module loads` | KEEP | A scripted external load probe reports both modules healthy; the guard must succeed without a rebuild side effect. Catches every test/deploy needlessly recompiling native modules; broken-module recovery cases do not establish the no-op fast path. |
| 38 | `rebuilds only the failing module, once, then re-checks it` | KEEP | A failing module becomes loadable only after one rebuild; literal result and side-effect records require only that module rebuilt and actually re-probed. Catches trusting rebuild exit status or recompiling healthy dependencies; two-failure batching is a distinct state. |
| 50 | `rebuilds all failing modules in a single call` | KEEP | Two externally failing probes must be rebuilt together in one invocation and then verified. Catches repeated expensive pnpm rebuild startup or forgetting a failing dependency; one-failure recovery cannot establish batching. |
| 58 | `still broken after rebuild: not ok, and main exits non-zero with the reason` | KEEP | A module still failing after rebuild causes CLI exit 1 and names the module/cause. Catches restarting a daemon that cannot load its native ABI; successful recovery cases cannot protect this release gate. |
| 71 | `a rebuild that reports failure but fixes the module still passes` | KEEP | When pnpm reports failure but the independent second load probe succeeds, main returns 0. Catches falsely blocking a repaired install based solely on installer status; persistent-failure and successful-installer cases do not establish the loadability authority. |
| 77 | `covers the daemon's native modules` | DELETE | Fails real-outcome/refactor/unique bars: compares the production NATIVE_MODULES name list to a duplicate expected inventory without loading either module. The real child probe plus existing daemon native use/build checks protect actual loadability; native names are not a user-facing configuration API. |
| 81 | `the real child probe reports load success and failure` | KEEP | Runs the real child-process probe with a builtin success and deliberately missing module, requiring the actual load error. Catches broken child spawn/status/stderr interpretation; injected probes in decision tests intentionally bypass this process boundary. |
| 87 | `detachBuildFiles gives hard-linked build files their own inode, content and mode intact` | KEEP | Real hardlinked addon bytes are detached, mode/content preserved, and later in-place writes cannot change the store; unrelated files remain linked and repeat invocation is harmless. Catches Electron rebuild poisoning pnpm shared binaries across checkouts; load probes alone cannot detect future shared-store corruption. |

## Standalone browser smoke scenarios

**Independent source / regression:** `scripts/smoke-web.mjs` documents the post-deploy startup gate; `scripts/smoke-web-fixtures.json` preserves the actual historical browser record that once crashed startup. The README-supported emitted web bundle must boot both new and retained browser state.

**Seam/oracle:** A fresh real Chromium context per scenario loads a supplied deployed URL after localStorage seeding. It must expose the Settings control and produce no uncaught page errors or console errors (only expected unauthenticated HTTP 401 logs are allowlisted). The fixed legacy record and actual runtime success can disagree with the implementation.

**Refactor/uniqueness:** Uses accessible app availability and runtime errors, not DOM geometry/tree/copy snapshots. This is the sole audited built-bundle/browser-startup owner; UI parser/unit tests and service-worker VM tests cannot establish that the actual bundle boots persisted localStorage. The legacy and empty contexts have distinct failure modes.

**Production caller/risk/cost:** This external gate targets the deployed web app, not the live daemon API. One browser is reused safely, each scenario has isolated storage/context, and browser.close runs in finally. It writes one PNG per scenario plus `results.json` to `SMOKE_ARTIFACT_DIR` or a fresh tempdir. Retain the two real browser loads; `networkidle2`/visible-control waits are condition-based. No browser smoke or deployment was executed by this documentation workstream.

| Scenario | Disposition | Unique protection |
| --- | --- | --- |
| `clean-storage` | KEEP | Fresh browser context with no saved state must render the built app Settings control without uncaught page/console errors. Catches broken emitted entry assets/provider initialization that pure UI/worker tests cannot prove. Settings is an accessible control seam, not exact marketing copy. |
| `legacy-usage-prefs-pre-agents-record` | KEEP | Seeds the literal historical version-1 orquester.app record whose usage preferences predate agents, before any bundle code runs, then requires usable Settings and no runtime errors. Catches the previously crashing cross-version bootstrap/migration integration; clean-storage and schema-only tests cannot establish that old browser state boots the emitted bundle. |

## Performance evidence and retained costs

The completed isolated baseline `pnpm test` exited 0 in **40:26.37** (`baseline-complete.time`), with **7,125.96 s user / 1,333.18 s system CPU**, reported 348% CPU and peak RSS **1,015,652 KiB**. This is whole-repository context, not attributable entirely to this root scope. The initial interrupted/ongoing `baseline.log` is not substituted for the completed measurement. Runner baseline uses the same supported Node 24 with legacy preloads, `TSX_DISABLE_CACHE=1` for TypeScript, package concurrency limits (where configured), serial workspace package scheduling, and Go `test -race`; no unsupported runtime comparison is claimed.

Observed root-scope baseline timings from `baseline-complete.log`:

| Target/case | Baseline observation | Reason retained |
| --- | ---: | --- |
| Box-agent cross-compilation integration | 7,244.833 ms | Unique real ELF/Mach-O/PE OS/CPU/link/manifest contract; mapping inventory is removed. |
| Box-agent Node test runner (5 declarations before cleanup) | 10,359.366 ms | Includes compiler and Node/tsx/preload overhead; not sum of test bodies. |
| Go agent package with race detector | 1.856 s | Actual process groups, buffer flow control, Unix sockets and ownership persistence need the Go implementation. |
| Go wire package with race detector | 1.140 s | Cross-language wire compatibility; fixture IO is small. |
| Desktop package runner | 10,090.203 ms | Many tiny tests plus isolated file/process startup; native shortcuts/security/persistence are distinct shell contracts. |
| Web-worker runner | 663.731 ms | VM/cache/control-time boundary avoids full browser launches. |
| Root scripts/deploy runner (26 declarations) | 9,904.899 ms | Includes real temporary Git/Bash deployments and child-load probe. |
| Manual rollback then failed deployment/revert | 2,796.027 ms | Two actual deployment cycles uniquely prove durable last-success selection. |
| Unhealthy release restored / prior release also unhealthy | 1,393.872 / 1,314.648 ms | Different required exit-code/recovery states; host services/network stubbed, no real health retries. |
| Healthy deployment | 1,307.566 ms | Durable success release/stamp/restart state, not just failure handling. |

Root already captured a post-change focused root scripts/deploy run in `root-focused.log`: **24/24 passed, 8,029.921 ms**. Baseline runner had 26 cases; this focused result is not a whole-suite after measurement, lacks repeat/variance sampling, and is not used to claim a comparable suite speedup. This report does not invent final wall time, absolute/percentage improvement or CI savings. The central completion report must supply the final comparable measurements.

Largest infrastructure changes remove universal ESM assertion loader registration/source rewriting and warning interception from every package file process, remove redundant transport executions/source probes, and replace custom notification fake-timer scaffolding with native virtual time. No arbitrary hard time limit, retry, disabled critical gate or shared mutable state is introduced. Cross-compilation and deployment Git setup remain intentionally real; reducing them further would remove the only protection at those artifact/commit boundaries.

## Validation record and commands

No test/typecheck/build command was launched by this documentation workstream because root schedules all validation to avoid baseline contention. Observed existing root logs are evidence, not claimed as new independent runs. Completed baseline full suite: passed (`baseline-complete.log`, exit 0). Root-focused script/deploy suite: passed 24/24 (`root-focused.log`). Other current checks/full final runs belong to the central report; no final state is inferred from a partial log.

Commands owning this scope, from repository package scripts (run from repository root unless noted):

```sh
pnpm --filter @orquester/box-agent test
pnpm --filter @orquester/desktop test
pnpm --filter @orquester/web test
node --test scripts/ensure-node-native.test.mjs scripts/check-changed.test.mjs scripts/deploy-public-url.test.mjs deploy/lib/remote-update.test.mjs
pnpm check:changed
pnpm check
pnpm test
# Inside apps/box-agent, the package runner includes:
node scripts/go.mjs test -race ./...
# Post-deploy gate, only against an explicitly selected safe app surface:
node scripts/smoke-web.mjs <deployed-url>
```

Current focused TypeScript runner preamble: `TSX_DISABLE_CACHE=1 node --import tsx --test`; use configured package timeout/concurrency or explicit `--test-timeout=600000 --test-concurrency=4`. Existing desktop/web scripts have no explicit cap, so baseline package timing must not be described as universally four workers. Root owns any runner-policy followup. `check-changed` planning now preserves both timeout and concurrency flags; standalone checks strip both.

Review-only commands for this report: baseline `git show bff9af49:<path>`, full scoped `git diff bff9af49`, AST declaration enumeration, production-caller `rg`, exact `git diff --numstat bff9af49` and `git diff --check -- docs/test-cleanup/2026-10/root.md`. They do not exercise behavior. No known root-scope baseline failure was found in the completed baseline. No post-change flakiness/variance or mutation result is claimed without a corresponding run.

Commit, remote integration, final full-suite timing and push are coordinated by the root agent and reported centrally. This workstream does not create commits or touch the remote.

## Final root validation evidence

`TSX_DISABLE_CACHE=1 node --import tsx --test src/menus.test.ts src/native-notifications.test.ts` from `apps/desktop`: **10/10 passed**, zero skips, runner112.616ms (process0.137s). Help-action invocation is independent of item order; expiry executes pending virtual timers without freezing the private lifetime tuning. Deployment shell syntax checks passed with `bash -n deploy.sh deploy/devtools-user.sh deploy/install-unit.sh deploy/install-go.sh deploy/provision-devtools.sh deploy/lib/remote-update.sh deploy/lib/remote-provision.sh deploy/lib/common.sh deploy/lib/ensure-public-url.sh`.

The temporary `python3 /tmp/orquester-test-audit/preload-ab.py` ran three alternating identical `navigation.test.ts` processes per configuration with TSX cache disabled: legacy hooks median1.204s (0.680–1.356s), native median1.606s (0.913–2.547s). All six processes passed. This contended small sample **does not demonstrate a preload-removal speedup**; no such saving is claimed. Removal is justified by the supported Node24 contract, native failure/timer probe and elimination of obsolete compatibility infrastructure. Whole-suite measurements and focused gains have separate owners. Exact commands/results are in `preload-ab.json` and `root-regression-probes.json` under the audit artifact directory.
