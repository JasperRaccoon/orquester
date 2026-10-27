# Desktop, web worker, box-agent and repository scripts audit

All 20 baseline test files under desktop, web worker, box-agent TS/Go, root scripts and deploy/lib; 113 named leaf declarations. TestMain is fixture dispatch, not a leaf test. Standalone smoke/performance scripts are outside this leaf-test audit.

Baseline: `beb7516b`. All listed tests and their production owners were read. The prior `docs/test-cleanup/2026-10/root.md` was used only to locate historical contracts; current source/fixtures were checked again.

Counts are baseline declarations, not expanded table iterations. CONSOLIDATE: **13**, KEEP: **86**, REWRITE: **14**. Removed declarations: **10**; no declarations added.

Test source: **2808 → 2750 LOC (-58)**.

Changes remove private helper duplication and incidental wording/call sequence assertions. Worker coverage now enters through registered browser events. Go environment-map coverage moves to the existing real hub exec workflow. Protocol decoding reads independent checked-in golden bytes. No production behavior changed; two check-changed test-only exports and five fixture-only exports become private. No fixture, dependency or snapshot became unused.

The real cross-platform build was **66,561.371 ms** in the baseline run (cold Go cache), and is intentionally retained: it uniquely links non-host OS sources and verifies emitted ABI/manifest data. Go already copies musl aliases rather than building twice. A warm-cache run is not a cleanup speedup. Existing deterministic Go drainPausedHook/outputDrainAfterExit seam remains necessary to prove the credit-stall regression without arbitrary real-time sleep or raising Go minimum for virtual-time support.

Per-file evidence below establishes all six requirements; each individual row identifies its distinct observable failure or surviving owner. No blanket coverage-count argument was used. Validation is scheduled centrally by the root agent; commands are targets until execution results are recorded.

## `apps/box-agent/internal/agent/agent_test.go`

1. **Independent contract:** packages/api/src/box-protocol.ts: detached-output offsets, connect endpoint and fs.watch ignore options; Agent daemon URL/OIDC audience contract.
2. **Recognizable failure:** Individual rows below state the broken caller-visible outcome.
3. **Independent oracle:** Authored hello/world byte offsets and stream tags; literal ws/wss URLs and allowed/ignored paths.
4. **Stable seam:** Detached-buffer read/bounds/finish boundary; daemon connection URL/audience policy; ignore matcher policy.
5. **Refactor resistance:** Assertions observe the stated data, process result, public command plan or platform API behavior rather than private collaborator order or source identifiers. Rewritten worker cases enter through registered browser events; command planning checks actual shell argv, so helper names and quote spelling may change.
6. **Unique protection:** Partial-buffer offsets, wait wakeup, OIDC subpath handling and distinct segment/glob/directory filtering have no equivalent Go owner. Private environment-map test is removed; real hub exec case owns env addition/replacement/unset.

Production callers: Agent.connectOnce/authentication, detached viewers, native/polling file watcher. Risk: Medium.
Validation: `cd apps/box-agent && node scripts/go.mjs test -race ./internal/agent`.

| Baseline test | Disposition | Evidence / surviving owner |
| --- | --- | --- |
| `TestRingKeepsNewestBytesAndReportsStart` | KEEP | Literal hello/world! chunks prove merged stdout/stderr offsets, a partially evicted chunk, bounded reads, explicit overrun and finish wakeup. Credible failures are wrong byte offsets, stream tags or a stranded reader; channel tests do not isolate these boundaries. |
| `TestConnectURL` | KEEP | Literal HTTP→WS/HTTPS→WSS connect URLs preserve a daemon sub-path, reject FTP and strip the path from the OIDC audience. Wrong scheme, endpoint or audience would prevent authentication; no launched-agent test covers these URL combinations. |
| `TestEnvMergeOverridesAndDeletes` | CONSOLIDATE (removed) | Removed private ordered-map manipulation. Real hub exec case seeds parent FOO=from-parent, child FOO=bar/ADDED=new and envUnset HOME; stdout independently proves replacement/addition/deletion through the wire. Surviving owner: `apps/daemon/src/boxes/hub/agent.integration.test.ts: exec with pipes: stdin, stdout, stderr, exit code, env merge, shell mode, spawn errors`. |
| `TestWatchIgnore` | KEEP | Literal ignored/not-ignored paths establish documented fs.watch ignore matching for a segment, wildcard and relative directory prefix, with allowed siblings. A matcher that leaks node_modules or suppresses src fails; host-side watch tests cannot exercise the separate Go implementation. |

## `apps/box-agent/internal/agent/exec_unix_test.go`

1. **Independent contract:** packages/api/src/box-protocol.ts channels, credit, resume offsets and error codes; AGENTS.md secrets stay host-only; Go Agent HTTP redirect privacy contract.
2. **Recognizable failure:** Individual rows below state the broken caller-visible outcome.
3. **Independent oracle:** Authored bytes/counts, OUTPUT_OVERRUN/BAD_REQUEST/ENOENT, shell output, OS account database, zero redirect-target requests.
4. **Stable seam:** Real Go agent WebSocket channels, shell processes, Unix sockets and HTTP requests.
5. **Refactor resistance:** Assertions observe the stated data, process result, public command plan or platform API behavior rather than private collaborator order or source identifiers. Rewritten worker cases enter through registered browser events; command planning checks actual shell argv, so helper names and quote spelling may change.
6. **Unique protection:** Each retained case addresses a distinct flow-control, initial/live overrun, secret/default environment, credential redirect, successful/failed Unix channel outcome. Host fixtures cannot replace this independent Go implementation.

Production callers: Agent channel opener, process environment, viewers/output pumps and daemon HTTP client. Risk: High.
Validation: `cd apps/box-agent && node scripts/go.mjs test -race ./internal/agent`.

| Baseline test | Disposition | Evidence / surviving owner |
| --- | --- | --- |
| `TestExecOutputTailSurvivesADaemonSlowerThanTheDrainDeadline` | KEEP | A real process emits one flow-control window plus a 50 KiB tail; after withheld credit reaches the drain boundary, every byte must arrive before successful exit/close. It catches truncation under backpressure, unlike bounded-buffer or ordinary process-exit tests. |
| `TestDetachedViewerThatFallsBehindItsBufferEndsWithAnError` | KEEP | An attached detached process is made to outgrow its actual buffer while credit stalls its viewer. The channel must close with literal OUTPUT_OVERRUN. Silent byte skipping is a different failure from initial attach loss, so both owners remain. |
| `TestAttachFromADroppedOffsetReportsTheLoss` | KEEP | A real process writes literal 16 bytes into an 8-byte detached buffer, then a later attach must report droppedBytes=8. This catches an incorrect initial resume cursor/loss report; the live-viewer overrun test checks a different phase. |
| `TestProcessesNeverInheritTheTailscaleAuthKey` | KEEP | A shell launched through the real channel must print key=none despite an agent-only Tailscale auth key in the parent environment. Literal output is independent and catches secret inheritance; config parsing does not protect child-process sanitization. |
| `TestProcessesGetHomeAndUserWhenOrqAgentHasNone` | KEEP | Reads expected home/user independently from the operating-system user database, instead of refreshSysInfo() under test, and checks a real shell receives them when the service environment lacks them. Catches broken git/CLI global-home setup; secret filtering does not test defaults. |
| `TestDaemonClientNeverFollowsRedirects` | KEEP | Both a direct client and an explicitly configured proxy receive a real HTTP redirect; the target hit counter must remain zero. Removes CheckRedirect-hook inventory while retaining credential-forwarding protection. Either transport accidentally following redirects fails on observable network traffic. |
| `TestUnixChannelBridgesASocketInTheBox` | KEEP | A real Unix echo socket exchanges literal vnc bytes through a box unix channel. It catches broken open/data bridging or premature close; invalid-path tests prove only refusal and cannot supersede successful byte transport. |
| `TestUnixChannelRefusesARelativePathAndAMissingSocket` | KEEP | Checks literal BAD_REQUEST for a relative path and ENOENT for a missing absolute socket, instead of accepting any open-failed. It now fails for an unrelated error; the positive socket test cannot prove these caller-visible error distinctions. |

## `apps/box-agent/internal/agent/orphan_linux_test.go`

1. **Independent contract:** AGENTS.md daemon process ownership and persistence rules; box-protocol lost-process identity; procstate.go PID/start identity compatibility.
2. **Recognizable failure:** Individual rows below state the broken caller-visible outcome.
3. **Independent oracle:** Independent OS children and identities, literal LOST/exit signals and persisted ownership/records.
4. **Stable seam:** Real OS process liveness/signals, durable temporary ownership records, wire attach/proc.list/proc.signal.
5. **Refactor resistance:** Assertions observe the stated data, process result, public command plan or platform API behavior rather than private collaborator order or source identifiers. Rewritten worker cases enter through registered browser events; command planning checks actual shell argv, so helper names and quote spelling may change.
6. **Unique protection:** Dead-owner recovery, live-owner refusal, lost attach/record lifecycle, and ignoring-SIGTERM escalation are separate failure modes absent from ordinary channel signal tests.

Production callers: Agent startup recovery and detached-process persistence. Risk: High.
Validation: `cd apps/box-agent && node scripts/go.mjs test -race ./internal/agent`.

| Baseline test | Disposition | Evidence / surviving owner |
| --- | --- | --- |
| `TestARestartStopsWhatThePreviousAgentLeftRunning` | KEEP | Real previous-owner processes and persisted PID/start identities verify restart recovery stops only matching leftovers, spares reused PIDs, reports LOST metadata, releases ended records and records new ownership. A PID-only kill or stale running record causes visible data/process loss. |
| `TestALiveOwnerKeepsItsProcesses` | KEEP | With a live recorded owner, actual child liveness and unchanged durable state prove another agent cannot take over or kill its processes. Dead-owner recovery exercises the opposite authorization decision and does not protect this refusal. |
| `TestDetachedProcessesAreRecordedAndALostOneCannotBeFollowed` | KEEP | Starts and ends a real detached process against the durable record, checks lost attach returns literal LOST and signaling a lost process succeeds harmlessly. It catches missing persistence, stale records or false reattach; static wire fixtures cannot prove lifecycle effects. |
| `TestALeftoverIgnoringSigtermIsKilled` | KEEP | A trap-ready real child ignores SIGTERM; bounded 100 ms grace must produce SIGKILL and the OS wait status must confirm it. This uniquely proves escalation for an uncooperative leftover; cooperative restart cleanup is insufficient. |

## `apps/box-agent/internal/agent/proc_unix_test.go`

1. **Independent contract:** AGENTS.md process/session ownership; box-protocol signal/close RPC and PTY resize; Unix process interface lifetime contract.
2. **Recognizable failure:** Individual rows below state the broken caller-visible outcome.
3. **Independent oracle:** OS observed death/group existence, SIGTERM/SIGKILL wait outcomes and race detector/resize failure after descriptor release.
4. **Stable seam:** Real processes and process groups, channel/proc.signal/close, process kill/signal/resize/release interface.
5. **Refactor resistance:** Assertions observe the stated data, process result, public command plan or platform API behavior rather than private collaborator order or source identifiers. Rewritten worker cases enter through registered browser events; command planning checks actual shell argv, so helper names and quote spelling may change.
6. **Unique protection:** Wire signal/close/RPC dispatch, whole-tree kill, racing descriptor release and a child that leaves its group fail independently. PTY and direct pipe paths have distinct kernel behavior.

Production callers: Go process implementation, agent channel handlers and shutdown. Risk: High.
Validation: `cd apps/box-agent && node scripts/go.mjs test -race ./internal/agent`.

| Baseline test | Disposition | Evidence / surviving owner |
| --- | --- | --- |
| `TestChannelSignalEndsTheWholeProcessGroup` | KEEP | Channel signals terminate actual shell and grandchild groups across direct exec, PTY and job-control cases, with the non-PTY exit signal checked. It catches leaked descendants or lost signal dispatch; the direct process kill seam cannot cover channel routing. |
| `TestChannelCloseHangsUpTheWholeProcessGroup` | KEEP | Closing an exec channel hangs up both the real parent and grandchild. This protects channel cancellation cleanup, which an explicit signal RPC or kill() test would still pass if channel-close handling broke. |
| `TestProcSignalEndsADetachedProcessGroup` | KEEP | The distinct proc.signal RPC terminates a detached parent and child, both PTY and direct, and replies successfully. It catches registry/RPC dispatch failures that a live exec-channel signal bypasses. |
| `TestPtyCallsRacingReleaseNeverUseAClosedMaster` | KEEP | Exercises process.signal(SIGWINCH) and resize concurrently with output close/release, instead of inspecting unixProcess.targets(). The Go race detector plus rejected post-release resize protects descriptor lifetime; group-shape changes are no longer asserted. |
| `TestKillEndsTheWholeTree` | KEEP | Direct process.kill() must SIGKILL the real child and descendants in ordinary and PTY job-control trees. Shutdown/internal cleanup uses this seam independently of signal()/channel dispatch, so a functioning remote signal path cannot supersede it. |
| `TestSignalFallsBackToThePidWhenTheGroupIsGone` | KEEP | The child fixture is dispatched from TestMain, while the actual regression still proves its original process group is gone, sends SIGTERM through process.signal(), and observes SIGTERM from wait(). Catches a stranded process that moved groups; no private targets() expectation remains. |

## `apps/box-agent/internal/agent/service_linux_test.go`

1. **Independent contract:** deploy/README.md needrestart exclusion and OOMPolicy=continue; independently specified Perl needrestart/systemd config syntax.
2. **Recognizable failure:** Individual rows below state the broken caller-visible outcome.
3. **Independent oracle:** Literal runtime-consumed Perl service regex, [Service]/OOMPolicy=continue bytes, directory absence and idempotent changed result.
4. **Stable seam:** Files written to temporary needrestart/systemd directories; whether a second write requires reload.
5. **Refactor resistance:** Assertions observe the stated data, process result, public command plan or platform API behavior rather than private collaborator order or source identifiers. Rewritten worker cases enter through registered browser events; command planning checks actual shell argv, so helper names and quote spelling may change.
6. **Unique protection:** Only tests of actual Go service-protection config output; shell deploy tests cover daemon, not box agent. OOM protection is a separate failure from package-upgrade exclusion.

Production callers: ProtectService at agent start/install. Risk: High.
Validation: `cd apps/box-agent && node scripts/go.mjs test -race ./internal/agent`.

| Baseline test | Disposition | Evidence / surviving owner |
| --- | --- | --- |
| `TestNeedrestartOverrideIsWrittenWhereNeedrestartIsInstalled` | KEEP | Reads the real temporary needrestart override and requires the literal Perl service-exclusion rule, rather than comparing to needrestartOverride from production or file mtime. It catches package upgrades unexpectedly restarting orq-agent and losing sessions; write deduplication is incidental. |
| `TestNeedrestartOverrideIsSkippedWithoutNeedrestart` | KEEP | With no needrestart installation directory, ProtectService helper must leave it absent. This distinguishes optional host integration from accidental creation of an unrelated package configuration; the installed-directory case cannot catch it. |
| `TestOOMPolicyDropInIsWrittenOnce` | KEEP | Literal systemd [Service]/OOMPolicy=continue file bytes prevent one OOM-killed child from stopping the agent; changed=false on second write avoids an unnecessary daemon reload. No other Go service test owns the OOM rule. |

## `apps/box-agent/internal/wire/wire_test.go`

1. **Independent contract:** packages/api/src/box-protocol.ts and checked-in fixtures/*.json are the independent TypeScript peer protocol.
2. **Recognizable failure:** Individual rows below state the broken caller-visible outcome.
3. **Independent oracle:** Checked-in JSON and frame hex, independently authored envelope fields and invalid stream/oversized payload.
4. **Stable seam:** Go strict control/channel/method decoders, JSON encoder, and binary frame codec.
5. **Refactor resistance:** Assertions observe the stated data, process result, public command plan or platform API behavior rather than private collaborator order or source identifiers. Rewritten worker cases enter through registered browser events; command planning checks actual shell argv, so helper names and quote spelling may change.
6. **Unique protection:** Go constants, discriminated controls, channel specs, RPC methods and byte framing can drift independently. TypeScript fixture generation cannot exercise Go field tags or strict decoding.

Production callers: Live Go agent WebSocket/RPC/channel protocol. Risk: High.
Validation: `cd apps/box-agent && node scripts/go.mjs test -race ./internal/wire`.

| Baseline test | Disposition | Evidence / surviving owner |
| --- | --- | --- |
| `TestConstants` | KEEP | Compares separately implemented Go wire constants/platforms with checked-in TypeScript interchange fixtures. Wrong protocol version, credit window, frame limit or path prefix breaks interoperating peers; this is cross-language compatibility, not an export inventory. |
| `TestControlMessages` | KEEP | Strictly decodes and re-encodes literal checked-in control JSON, preserving optional/null fields and all message kinds. A renamed/dropped Go field or unrecognized control type fails even if Go code compiles; typed TS fixtures alone cannot test Go decoding. |
| `TestChannelSpecs` | KEEP | Literal channel-spec JSON is strictly decoded/re-encoded by its Go constructor and DecodeSpec must return the fixture kind. Catches wrong union dispatch, missing fields or serialization incompatibility that generic control envelopes do not inspect. |
| `TestMethods` | KEEP | Each checked-in host→box and box→host method parameter/result sample is strictly round-tripped through independently implemented Go types. Catches renamed RPC fields, incorrect result voidness and method incompatibility; handler registration tests cannot prove these values. |
| `TestDataFrames` | KEEP | Independent fixture frame hex and payload hex verify Go encoding/decoding, stream/channel values, invalid stream refusal and oversize rejection. Catches byte order or framing errors that JSON compatibility and TypeScript-only frame decoding cannot detect. |

## `apps/box-agent/src/build.test.ts`

1. **Independent contract:** deploy/README.md cross-platform Go agent delivery; packages/api/src/box-protocol.ts supported platform contract; OS ELF/Mach-O/PE ABI.
2. **Recognizable failure:** Individual rows below state the broken caller-visible outcome.
3. **Independent oracle:** Independent target→OS/CPU table and executable-header decoding; file SHA-256/size and persisted JSON.
4. **Stable seam:** buildBoxAgent outputs real executable files and manifest.
5. **Refactor resistance:** Assertions observe the stated data, process result, public command plan or platform API behavior rather than private collaborator order or source identifiers. Rewritten worker cases enter through registered browser events; command planning checks actual shell argv, so helper names and quote spelling may change.
6. **Unique protection:** Only link-level validation for all OS-specific Go sources and manifest identity; native Go tests compile only host architecture. Five distinct GOOS/GOARCH builds remain; musl aliases are already copied once by production.

Production callers: Daemon BoxAgentBuilds and packaging/prebuild CLI. Risk: High.
Validation: `cd apps/box-agent && TSX_DISABLE_CACHE=1 node --import tsx --test src/build.test.ts`.

| Baseline test | Disposition | Evidence / surviving owner |
| --- | --- | --- |
| `every platform cross-compiles and links for its OS and CPU` | KEEP | Independent ELF/Mach-O/PE header/CPU oracle validates every supported OS/architecture plus manifest digest/size/version. Host-only Go tests cannot detect non-host linker/source failures. Already builds five GOOS/GOARCH pairs and copies musl aliases. |

## `apps/box-agent/src/fixtures.test.ts`

1. **Independent contract:** packages/api/src/box-protocol.ts and checked-in box-agent golden fixtures shared with the separately implemented Go peer.
2. **Recognizable failure:** Individual rows below state the broken caller-visible outcome.
3. **Independent oracle:** Checked-in JSON/frame hex is read directly; decoder expectations no longer come from the encoder under test.
4. **Stable seam:** Persisted golden fixture bytes against typed fixture producer; public TypeScript control/frame decoding.
5. **Refactor resistance:** Assertions observe the stated data, process result, public command plan or platform API behavior rather than private collaborator order or source identifiers. Rewritten worker cases enter through registered browser events; command planning checks actual shell argv, so helper names and quote spelling may change.
6. **Unique protection:** Golden consistency owns TS→Go compatibility; merged decoder owner detects dropped control fields/wrong binary interpretation. Go strict decoding tests cannot catch a TS decoder regression.

Production callers: Box client/hub protocol parser/frame codec; Go peer consumes same goldens. Risk: High.
Validation: `cd apps/box-agent && TSX_DISABLE_CACHE=1 node --import tsx --test src/fixtures.test.ts`.

| Baseline test | Disposition | Evidence / surviving owner |
| --- | --- | --- |
| `golden fixtures match the typed TypeScript values (UPDATE_FIXTURES=1 rewrites them)` | KEEP | Typed TypeScript samples must equal checked-in interchange JSON consumed by Go; UPDATE_FIXTURES is an explicit opt-in, not part of validation. Catches unintentional wire-byte/key drift across versions, independently of whether current encoder and decoder agree with one another. |
| `every control fixture parses as a control message of its type` | CONSOLIDATE (removed) | Discriminator-only generated-fixture loop removed. Merged golden decoder owner compares the entire parsed control object against checked-in independent JSON, detecting field loss as well as wrong type. Surviving owner: `apps/box-agent/src/fixtures.test.ts: golden control and frame bytes decode without losing data`. |
| `frame fixtures decode back to their payloads` | REWRITE | Survivor renamed golden control and frame bytes decode without losing data. Reads checked-in control/frame bytes directly, asserts full controls and literal channel/stream/payload; removes decode(encode(...)) oracle dependency and absorbs weaker discriminator loop. |

## `apps/desktop/src/http-stream.test.ts`

1. **Independent contract:** AGENTS.md preserve terminal streaming; pipeHttpStream public sink exactly-once/error/body contract; daemon restart/revocation stream behavior.
2. **Recognizable failure:** Individual rows below state the broken caller-visible outcome.
3. **Independent oracle:** Literal payload, 401 status and exactly one end; no error body leaked.
4. **Stable seam:** Actual HTTP GET over loopback/Unix socket and stream sink data/end.
5. **Refactor resistance:** Assertions observe the stated data, process result, public command plan or platform API behavior rather than private collaborator order or source identifiers. Rewritten worker cases enter through registered browser events; command planning checks actual shell argv, so helper names and quote spelling may change.
6. **Unique protection:** Clean completion, HTTP error, connection failure and Unix mid-response cut are separate transport outcomes. Renderer status mapper cannot test Node HTTP close handling.

Production callers: main.ts HTTP/IPC event and output streams. Risk: High.
Validation: `cd apps/desktop && TSX_DISABLE_CACHE=1 node --import tsx --test src/http-stream.test.ts`.

| Baseline test | Disposition | Evidence / surviving owner |
| --- | --- | --- |
| `a clean end ends the stream once` | KEEP | A real successful HTTP response delivers literal all newline bytes and ends once. This catches lost normal data or duplicate end notifications; aborted/error responses are distinct failure paths and cannot supersede normal completion. |
| `an error answer reports its status once and never its body` | KEEP | Real 401 response must yield no stream bytes and exactly one end carrying401; prevents auth-error JSON being interpreted as terminal/chat data. |
| `a request that cannot connect ends the stream once` | KEEP | A request to an actually closed local listener must end once. It catches connection refusal leaving a subscriber hanging, before any IncomingMessage exists; response completion/abort cases cannot cover it. |
| `over the unix socket: a daemon restart cutting the stream ends it once` | KEEP | Real Unix response is destroyed after observed first data; sink receives those bytes and one end, allowing immediate reconnect after embedded daemon restart. |

## `apps/desktop/src/menus.test.ts`

1. **Independent contract:** docs/superpowers/research/2026-10-22-t3code-gap/09-desktop-settings-onboarding.md §§2.3,3 desktop window/menu/notification requirements; AGENTS.md validate bridge inputs.
2. **Recognizable failure:** Individual rows below state the broken caller-visible outcome.
3. **Independent oracle:** Electron-defined roles and Settings shortcut; independently captured settings/logs/dictionary action values.
4. **Stable seam:** Electron application/context MenuItemConstructorOptions roles, accelerators and invoked user actions.
5. **Refactor resistance:** Assertions observe the stated data, process result, public command plan or platform API behavior rather than private collaborator order or source identifiers. Rewritten worker cases enter through registered browser events; command planning checks actual shell argv, so helper names and quote spelling may change.
6. **Unique protection:** macOS edit roles/Windows quit routing, enabled editor actions, spelling replacement and outside-field Copy have distinct caller-visible behavior; no renderer test owns OS menus.

Production callers: main.ts native menu installation. Risk: Medium.
Validation: `cd apps/desktop && TSX_DISABLE_CACHE=1 node --import tsx --test src/menus.test.ts`.

| Baseline test | Disposition | Evidence / surviving owner |
| --- | --- | --- |
| `provides native shortcuts and routes Settings and logs actions on macOS` | KEEP | Electron native edit/view/quit/close roles and CmdOrCtrl+, must exist; invoking Settings/log actions records independently expected operations. No renderer test can provide OS keyboard menu routing. |
| `provides the Settings shortcut and Quit on Windows` | KEEP | Windows menu contains native quit and its Settings accelerator invokes the renderer-facing settings action; macOS has a different native menu structure. |
| `offers cut, copy, paste and select all in an editable field, enabled as the field allows` | KEEP | Checks cut/copy disabled and paste/select-all enabled by the supplied Electron edit flags, locating actions by semantic role. Removes ordered label-tree assertions. Catches clipboard actions enabled against native capability or valid actions disabled; app-menu roles do not test context state. |
| `replaces a misspelling and adds the original word to the dictionary` | KEEP | Native context-menu actions deliver the selected suggestion and original misspelling independently; user-supplied spelling data, not incidental copy/count, is asserted. |
| `offers Copy over a selection outside a field, and nothing over plain page` | KEEP | Requires Copy for a non-editable selection and an empty menu for whitespace/plain page, instead of exact incidental menu trees. Catches lost text-copy affordance or unwanted page interception; editable-field cases protect a different context. |

## `apps/desktop/src/native-notifications.test.ts`

1. **Independent contract:** docs/superpowers/research/2026-10-22-t3code-gap/09-desktop-settings-onboarding.md §§2.3,3 desktop window/menu/notification requirements; AGENTS.md validate bridge inputs.
2. **Recognizable failure:** Individual rows below state the broken caller-visible outcome.
3. **Independent oracle:** Literal accepted/rejected payloads, nonnegative integer counts, independently observed replacements and virtual-time release.
4. **Stable seam:** Untrusted renderer notification/badge parser and tag lifecycle registry consumed by Electron notifications.
5. **Refactor resistance:** Assertions observe the stated data, process result, public command plan or platform API behavior rather than private collaborator order or source identifiers. Rewritten worker cases enter through registered browser events; command planning checks actual shell argv, so helper names and quote spelling may change.
6. **Unique protection:** Payload privacy/validation, numeric badge boundary, late-close replacement safety and expiry are distinct. Renderer notification-selection tests never exercise the main-process trust boundary.

Production callers: main.ts notify/badge IPC and Notification lifecycle. Risk: High.
Validation: `cd apps/desktop && TSX_DISABLE_CACHE=1 node --import tsx --test src/native-notifications.test.ts`.

| Baseline test | Disposition | Evidence / surviving owner |
| --- | --- | --- |
| `accepts renderer notification targets and trims the title` | KEEP | Main-process bridge parser retains session/workflow target identities and safely degrades malformed run ID; protects the Electron notification trust boundary independently of renderer notification selection. |
| `refuses anything else` | KEEP | Literal malformed IPC values, wrong field types, invalid tags and unsafe/unknown target shapes must be refused. Catches untrusted renderer data reaching native notifications or arbitrary navigation; accepted-payload tests cannot protect this validation boundary. |
| `takes only whole, non-negative attention counts` | KEEP | Rejects malformed/negative/fractional/non-finite bridge badge counts while allowing zero and positive integers; prevents untrusted renderer payload reaching native APIs. |
| `replaces a notification with the same tag and hands back the old one to close` | KEEP | Uses native virtual timers and public hold() return values: replacing a tag returns its previous item, and late release of the old item cannot discard its replacement. Removes injected timer protocol and size inventory; catches lost click handlers on notification replacement. |
| `lets go on click, close or failure, and on its own once the hold lapses` | KEEP | Runs pending native virtual timers and observes hold() outcomes to prove explicit release and eventual expiry for distinct tags. Removes custom lifetime/timer fakes and internal size checks; catches leaked holds or premature retention after release. |

## `apps/desktop/src/navigation.test.ts`

1. **Independent contract:** README security model; AGENTS.md host-only secrets; configured remote-base and signed visual-route transport contracts.
2. **Recognizable failure:** Individual rows below state the broken caller-visible outcome.
3. **Independent oracle:** Authored safe/unsafe URLs, literal allow/download/deny/external outcomes and remote path expectations; real ApiClient constructs nested DevTools credential URL.
4. **Stable seam:** Main-frame/window-open navigation decisions and orq-visual scheme endpoint resolution.
5. **Refactor resistance:** Assertions observe the stated data, process result, public command plan or platform API behavior rather than private collaborator order or source identifiers. Rewritten worker cases enter through registered browser events; command planning checks actual shell argv, so helper names and quote spelling may change.
6. **Unique protection:** Only main-process navigation credential boundary. Distinct local-page, download base, nested credential, scheme and visual target failures are not owned by renderer deep-link tests.

Production callers: main.ts will-navigate/window-open/visual protocol handlers. Risk: High.
Validation: `cd apps/desktop && TSX_DISABLE_CACHE=1 node --import tsx --test src/navigation.test.ts`.

| Baseline test | Disposition | Evidence / surviving owner |
| --- | --- | --- |
| `are read off the paths the client appends to its endpoint` | KEEP | Literal API/session and health URLs yield their configured daemon bases, including sub-paths; unrelated routes and file URLs do not. Catches trust records that authorize the wrong origin/path before download decisions; downstream cases cannot enumerate base discovery inputs. |
| `stays on the app's own document, whatever its fragment` | KEEP | Allows only the app document plus fragment, including the development origin, and rejects another local file. Catches renderer navigation escaping the installed document; external-link routing deliberately has a separate allow policy. |
| `downloads a remote's file itself, so the token reaches only that daemon` | KEEP | Known root and sub-path daemon download URLs produce download actions carrying their original token only to that daemon. Catches authenticated downloads sent to a browser or denied; negative unknown-base tests do not establish the valid flow. |
| `downloads only at a remote's configured base, never another prefix on its origin` | KEEP | Literal wrong prefixes on a known daemon origin must be denied. Catches an origin-only allowlist leaking a credential to another application at that host; positive configured-base downloads cannot detect overbroad trust. |
| `never hands a URL with a credential to the system browser, however nested` | KEEP | Real ApiClient DevTools URLs and literal nested/query/fragment/userinfo credentials must never become external browser links for either navigation entrypoint, while innocuous queries remain allowed. Catches credential exfiltration across encoding/nesting forms; ordinary external-link tests have no secrets. |
| `refuses a value nested past the unwrapping bound` | KEEP | Deeply encoded token-bearing input must fail closed beyond the bounded unwrap depth. Catches bounded scanning incorrectly treating unexamined input as safe; shallower recognized credential shapes cannot protect exhaustion behavior. |
| `sends an ordinary link to the system browser and refuses other schemes` | KEEP | Literal ordinary HTTPS/mailto links are external, while javascript/data/local-file schemes are denied. Catches unsafe URL execution or broken normal linking; credential-denial tests alone could pass an implementation that denies every URL. |
| `a window.open of a remote download is downloaded too` | KEEP | A window.open download uses the authenticated download action. Catches pop-up routing bypassing the normal-navigation download policy; the other positive-download test enters navigationAction, not this separate public entrypoint. |
| `names the local daemon's page by path` | KEEP | Literal orq-visual://local page URLs resolve only the permitted local visual path; fs.download is rejected. Catches custom-scheme escalation to arbitrary local daemon routes; remote visual routing uses a different address form. |
| `names a remote's page at its base, keeping a daemon's sub-path` | KEEP | Literal registered remote visual URLs preserve root/sub-path endpoints and the signed page path. Catches a visual routed to the wrong daemon or stripped prefix; rejection cases cannot prove successful page loading. |
| `refuses an unknown remote, another prefix on a known origin, a non-page route, or more than a path` | KEEP | Unregistered origins, wrong prefixes, userinfo/query-bearing endpoints, non-page routes and non-custom schemes resolve to null. Catches custom-scheme remote credential/route escalation; ordinary download/navigation guards are separate callers. |

## `apps/desktop/src/transport/stream-status.test.ts`

1. **Independent contract:** AGENTS.md validate bridge values; streaming transport reports HTTP error status so revoked tokens stop retrying.
2. **Recognizable failure:** Individual rows below state the broken caller-visible outcome.
3. **Independent oracle:** Literal callback sequence/status with malformed values and absent error consumer.
4. **Stable seam:** Bridge end callback→consumer onError/onEnd boundary.
5. **Refactor resistance:** Assertions observe the stated data, process result, public command plan or platform API behavior rather than private collaborator order or source identifiers. Rewritten worker cases enter through registered browser events; command planning checks actual shell argv, so helper names and quote spelling may change.
6. **Unique protection:** HTTP piping tests observe main-process sink, not renderer bridge status validation/callback ordering. Wrong bridge type and optional consumer handling are distinct.

Production callers: Desktop transporter IPC stream handler. Risk: Medium.
Validation: `cd apps/desktop && TSX_DISABLE_CACHE=1 node --import tsx --test src/transport/stream-status.test.ts`.

| Baseline test | Disposition | Evidence / surviving owner |
| --- | --- | --- |
| `a status-reported end is an error carrying the status, then the end` | KEEP | Integer 401/503 bridge statuses produce onError carrying that exact status before onEnd. Catches revoked streams retrying indefinitely because authentication failure was erased; main-process HTTP tests stop before renderer callback interpretation. |
| `a plain end (a clean one, or a stream the daemon cut) is only the end` | KEEP | Undefined/200 status produces only onEnd. Catches clean/restarted streams becoming false authorization failures; explicit error-status coverage cannot protect normal reconnect behavior. |
| `a malformed status from the bridge is a plain end` | KEEP | Literal malformed bridge statuses produce a plain end, not a fabricated HTTP error. Catches invalid IPC payloads causing UI failure handling; numeric valid statuses do not test boundary validation. |
| `a consumer without onError still gets its end` | KEEP | A valid error status still invokes onEnd when onError is omitted. Catches older/minimal consumers hanging or throwing on optional callbacks; other cases always install the error handler. |

## `apps/desktop/src/window-lifecycle.test.ts`

1. **Independent contract:** docs/superpowers/research/2026-10-22-t3code-gap/09-desktop-settings-onboarding.md §§2.3,3 desktop window/menu/notification requirements; AGENTS.md validate bridge inputs. Current titlebar rebuild workflow in main.ts must preserve tray visibility and pending renderer messages.
2. **Recognizable failure:** Individual rows below state the broken caller-visible outcome.
3. **Independent oracle:** Literal show/create/wait states and observed one-shot ordered drain.
4. **Stable seam:** Window show/replacement/delivery policy and FIFO renderer outbox.
5. **Refactor resistance:** Assertions observe the stated data, process result, public command plan or platform API behavior rather than private collaborator order or source identifiers. Rewritten worker cases enter through registered browser events; command planning checks actual shell argv, so helper names and quote spelling may change.
6. **Unique protection:** These cheap policy boundaries own third-window prevention, hidden-tray replacement, loaded-page delivery and queued-once ordering without requiring Electron startup. Persistence geometry tests cover a different boundary.

Production callers: main.ts createWindow/showWindow and renderer notification/menu delivery. Risk: Medium.
Validation: `cd apps/desktop && TSX_DISABLE_CACHE=1 node --import tsx --test src/window-lifecycle.test.ts`.

| Baseline test | Disposition | Evidence / surviving owner |
| --- | --- | --- |
| `brings the window on screen forward, mid-rebuild too, instead of opening a third` | KEEP | Literal visible-main/rebuild states must choose show-main. Catches a tray/second-launch request creating a third window while a replacement loads; no-main cases cannot expose duplicate creation when the old window still exists. |
| `creates a window only when there is none and none is on its way` | KEEP | Without a main window, chooses create normally but wait during replacement startup. Catches a hidden unusable app or a second concurrent replacement; existing-window cases use a different state. |
| `lets the replacement show only in place of a window that was showing` | KEEP | Only a visible, non-destroyed original lets its replacement show. Catches a titlebar change exposing an app hidden to tray or resurrecting a destroyed window; show-window routing does not determine replacement visibility. |
| `go only to a loaded main page, and wait out a rebuild for the replacement` | KEEP | Renderer delivery requires a loaded main page outside rebuild. Catches notification/deep-link messages delivered into a soon-destroyed page; the outbox test establishes storage order, not when delivery is permitted. |
| `queues messages in order and drains them once` | KEEP | Literal queued a/b/c messages are delivered FIFO once with empty second drain, preventing lost/repeated notification/menu navigation during titlebar rebuild. |

## `apps/desktop/src/window-state.test.ts`

1. **Independent contract:** docs/superpowers/research/2026-10-22-t3code-gap/09-desktop-settings-onboarding.md §§2.3,3 desktop window/menu/notification requirements; AGENTS.md validate bridge inputs. Persisted device-local window-state.json tolerates old/invalid fields and missing displays.
2. **Recognizable failure:** Individual rows below state the broken caller-visible outcome.
3. **Independent oracle:** Authored saved bounds/malformed records/display setups and Electron frame/control outcomes.
4. **Stable seam:** Persisted window state parser, monitor-aware restore and Electron native-frame/control policy.
5. **Refactor resistance:** Assertions observe the stated data, process result, public command plan or platform API behavior rather than private collaborator order or source identifiers. Rewritten worker cases enter through registered browser events; command planning checks actual shell argv, so helper names and quote spelling may change.
6. **Unique protection:** Geometry here is functional usability/persisted configuration: offscreen windows or no caption controls. Each retained case owns a distinct state/monitor/platform condition, not incidental DOM pixels.

Production callers: main.ts window-state persistence and BrowserWindow creation. Risk: Medium.
Validation: `cd apps/desktop && TSX_DISABLE_CACHE=1 node --import tsx --test src/window-state.test.ts`.

| Baseline test | Disposition | Evidence / surviving owner |
| --- | --- | --- |
| `reads saved bounds and the maximized flag` | KEEP | Literal saved position/size and maximized=true survive parsing. Catches loss of persisted window state; invalid-record and multi-monitor placement tests do not test parsing of the maximized field. |
| `keeps negative saved positions for a display left of the primary` | KEEP | Authored negative x/y saved coordinates survive parsing, preventing valid left/upper-monitor placement being discarded; positive saved bounds do not protect this persisted compatibility case. |
| `degrades a file from another version, or garbage, to the defaults field by field` | KEEP | Uses explicit empty-state literals and field-wise malformed persistence examples instead of DEFAULT_WINDOW_STATE. Catches corrupted/older records crashing startup, accepting unsafe dimensions or losing a valid maximized flag; valid roundtrip alone cannot protect tolerance. |
| `restores bounds that fit on any connected display` | KEEP | Literal bounds fully on the primary or another connected display must be restored unchanged. This geometry is the persisted user placement contract, not incidental appearance; catches incorrectly recentering every restart and is distinct from absent-monitor recovery. |
| `centres the saved size on the primary display when its monitor is gone` | KEEP | When the saved monitor disappears but its size fits the primary, returns that literal size without x/y so Electron centers it. Catches reopening off-screen or losing usable size; an on-screen restoration case cannot protect disconnected displays. |
| `falls back to the default size when the saved one fits nowhere, nothing was saved, or no display is known` | KEEP | Checks positive fallback dimensions and omission of x/y for unusable/missing records or no displays, plus recentering a straddling window. Removes production DEFAULT_WINDOW_SIZE equality. Catches invisible startup while permitting behavior-preserving default-size changes. |
| `keeps macOS's hidden titlebar with traffic lights whatever the setting` | KEEP | Checks macOS hidden titlebar/native controls and identical frame identity across the custom-titlebar setting, without fixed traffic-light coordinates. Catches disappearing OS controls or unnecessary window replacement; Windows/Linux follow a separate platform contract. |
| `gives Windows and Linux the OS frame and its buttons when the custom titlebar is off` | KEEP | Literal Windows/Linux native versus custom frame options, changed frame identity and native-control visibility follow the user setting. Catches duplicate/missing window buttons or failure to rebuild; macOS deliberately keeps the same native-control policy. |

## `apps/web/test/sw.test.mjs`

1. **Independent contract:** README Mobile/PWA/offline shell/notification workflow; apps/web/public/sw.js documented cache/network-fallback policy; browser Fetch/Push/notificationclick platform contract.
2. **Recognizable failure:** Individual rows below state the broken caller-visible outcome.
3. **Independent oracle:** Authored HTML/resources and deep links/messages; fake fetch controlled independently; expected cached HTML/network failure and bounded asset data.
4. **Stable seam:** Registered fetch, notificationclick and push event handlers; observable responses, Cache Storage contents and client navigation/focus.
5. **Refactor resistance:** Assertions observe the stated data, process result, public command plan or platform API behavior rather than private collaborator order or source identifiers. Rewritten worker cases enter through registered browser events; command planning checks actual shell argv, so helper names and quote spelling may change.
6. **Unique protection:** One overflow owner covers pinned-shell and absent-shell behavior; one click owner covers target/dispatch across existing/new windows; push owns target retention; four navigation owners cover timely, late, cold and failed network. Helpers/cache-version identifiers no longer enter expectations.

Production callers: Browser-managed classic service worker; no production test-only exports. Risk: High.
Validation: `pnpm --filter @orquester/web test`.

| Baseline test | Disposition | Evidence / surviving owner |
| --- | --- | --- |
| `trims the oldest assets past the limit but never the shell's own` | CONSOLIDATE | Surviving overflow owner exercises registered fetch and observes bounded Cache Storage, evicted oldest unrelated asset, preserved pinned entry/preload/style and newest resource. Covers with/without cached shell in one fixture; drops private trimCache seam and current cache-version names. Surviving owner: `apps/web/test/sw.test.mjs: evicts old assets on overflow, preserving every resource the offline shell needs`. |
| `without a cached shell, trims oldest first as before` | CONSOLIDATE (removed) | Surviving overflow owner exercises registered fetch and observes bounded Cache Storage, evicted oldest unrelated asset, preserved pinned entry/preload/style and newest resource. Covers with/without cached shell in one fixture; drops private trimCache seam and current cache-version names. Surviving owner: `apps/web/test/sw.test.mjs: evicts old assets on overflow, preserving every resource the offline shell needs`. |
| `a session's opens that session's tab` | CONSOLIDATE | Surviving registered notificationclick owner observes literal session/workflow/run URLs/messages and safe generic fallback, focused existing client without a duplicate window or correct new-window link, notification closure and waitUntil lifetime. Removes helper/dispatch replay at multiple seams. Surviving owner: `apps/web/test/sw.test.mjs: opens the notified target, reusing an existing window or starting at its deep link`. |
| `a workflow run's opens the run, as before` | CONSOLIDATE (removed) | Surviving registered notificationclick owner observes literal session/workflow/run URLs/messages and safe generic fallback, focused existing client without a duplicate window or correct new-window link, notification closure and waitUntil lifetime. Removes helper/dispatch replay at multiple seams. Surviving owner: `apps/web/test/sw.test.mjs: opens the notified target, reusing an existing window or starting at its deep link`. |
| `anything else (the test push, a malformed id) just opens the app` | CONSOLIDATE (removed) | Surviving registered notificationclick owner observes literal session/workflow/run URLs/messages and safe generic fallback, focused existing client without a duplicate window or correct new-window link, notification closure and waitUntil lifetime. Removes helper/dispatch replay at multiple seams. Surviving owner: `apps/web/test/sw.test.mjs: opens the notified target, reusing an existing window or starting at its deep link`. |
| `an open window is focused and told which session to open` | CONSOLIDATE (removed) | Surviving registered notificationclick owner observes literal session/workflow/run URLs/messages and safe generic fallback, focused existing client without a duplicate window or correct new-window link, notification closure and waitUntil lifetime. Removes helper/dispatch replay at multiple seams. Surviving owner: `apps/web/test/sw.test.mjs: opens the notified target, reusing an existing window or starting at its deep link`. |
| `with no window open, a new one starts on the session's link` | CONSOLIDATE (removed) | Surviving registered notificationclick owner observes literal session/workflow/run URLs/messages and safe generic fallback, focused existing client without a duplicate window or correct new-window link, notification closure and waitUntil lifetime. Removes helper/dispatch replay at multiple seams. Surviving owner: `apps/web/test/sw.test.mjs: opens the notified target, reusing an existing window or starting at its deep link`. |
| `the click handler closes the notification and waits for the window` | CONSOLIDATE (removed) | Surviving registered notificationclick owner observes literal session/workflow/run URLs/messages and safe generic fallback, focused existing client without a duplicate window or correct new-window link, notification closure and waitUntil lifetime. Removes helper/dispatch replay at multiple seams. Surviving owner: `apps/web/test/sw.test.mjs: opens the notified target, reusing an existing window or starting at its deep link`. |
| `a push keeps the session, workflow and run ids for the tap` | KEEP | Invokes the actual push handler and checks independent session/workflow/run identifiers in showNotification data. Catches target IDs dropped before the later click; click-only tests handcraft already-present data. |
| `answers from the network when it comes in time, and caches the shell` | REWRITE | Enters registered fetch handler and observes network response/cached HTML rather than calling private networkFirstNavigation. Cache seeding uses a prior successful event, so cache-version/helper identifiers may change. Virtual network/time still proves this distinct timely/late/cold/offline outcome. |
| `serves the cached shell once the timeout passes, and still caches the late answer` | REWRITE | Enters registered fetch handler and observes network response/cached HTML rather than calling private networkFirstNavigation. Cache seeding uses a prior successful event, so cache-version/helper identifiers may change. Virtual network/time still proves this distinct timely/late/cold/offline outcome. |
| `without a cached shell, waits on the network past the timeout` | REWRITE | Enters registered fetch handler and observes network response/cached HTML rather than calling private networkFirstNavigation. Cache seeding uses a prior successful event, so cache-version/helper identifiers may change. Virtual network/time still proves this distinct timely/late/cold/offline outcome. |
| `offline, answers the cached shell, or a network error without one` | REWRITE | Enters registered fetch handler and observes network response/cached HTML rather than calling private networkFirstNavigation. Cache seeding uses a prior successful event, so cache-version/helper identifiers may change. Virtual network/time still proves this distinct timely/late/cold/offline outcome. |

## `deploy/lib/remote-update.test.mjs`

1. **Independent contract:** deploy/README.md deploy/rollback health state, durable last-success marker, RESET_REF/AUTO_REVERT and exit codes 0/1/3/4.
2. **Recognizable failure:** Individual rows below state the broken caller-visible outcome.
3. **Independent oracle:** Actual commit IDs, persisted stamp/marker, literal exit codes and observed restart history; version/commit summary is documented operational output.
4. **Stable seam:** Actual Bash payload in a temporary Git repo with local bare origin; independently controlled installer/systemctl/HTTP dependencies.
5. **Refactor resistance:** Assertions observe the stated data, process result, public command plan or platform API behavior rather than private collaborator order or source identifiers. Rewritten worker cases enter through registered browser events; command planning checks actual shell argv, so helper names and quote spelling may change.
6. **Unique protection:** Each release/build/health/rollback state has a distinct recovery or downtime failure. Stubs isolate host side effects but do not implement checkout/rollback logic under test.

Production callers: deploy.sh deploy/rollback payload. Risk: High.
Validation: `node --test deploy/lib/remote-update.test.mjs`.

| Baseline test | Disposition | Evidence / surviving owner |
| --- | --- | --- |
| `a healthy release deploys, records itself and prints its version and commit` | REWRITE | Runs the actual Bash payload against temporary Git/origin and stubbed host commands; verifies release HEAD, version/commit stamp, successful-deploy marker and exactly one restart. Catches success being reported for the wrong release; failure cases cannot prove durable success state. Removes incidental OK/rollback/failure prose assertions; documented exit codes, actual HEAD/marker/stamp/restarts continue to own the outcome. |
| `an unhealthy release is rolled back to the previous one, which is restarted and healthy; the deploy fails` | REWRITE | A newly unhealthy release must restore the previous durable release, rebuild/restart it, preserve its success marker and exit 3. Catches deploying a dead daemon or falsely reporting success after revert; healthy deployment has no rollback path. Removes incidental OK/rollback/failure prose assertions; documented exit codes, actual HEAD/marker/stamp/restarts continue to own the outcome. |
| `when the previous release does not come back either, the deploy fails loudly with its own code` | REWRITE | If both new and previous releases fail health, exit 4 and checked tree/restart history expose the rollback failure. Catches treating a down service as safely restored; successful auto-revert deliberately ends healthy. Removes incidental OK/rollback/failure prose assertions; documented exit codes, actual HEAD/marker/stamp/restarts continue to own the outcome. |
| `AUTO_REVERT=0 leaves the unhealthy release in place and fails` | REWRITE | AUTO_REVERT=0 must leave the unhealthy new commit in place, restart only once and exit 1. Catches a disabled rollback unexpectedly replacing a release; default rollback must do the opposite. Removes incidental OK/rollback/failure prose assertions; documented exit codes, actual HEAD/marker/stamp/restarts continue to own the outcome. |
| `a failed build never restarts the daemon` | REWRITE | A failed real-script build step must keep the running daemon untouched, with zero restart calls and a failed exit. Catches downtime caused by restarting into an incomplete build; health failures occur only after a successful build. Removes incidental OK/rollback/failure prose assertions; documented exit codes, actual HEAD/marker/stamp/restarts continue to own the outcome. |
| `the manual rollback to a sha still works, and a later unhealthy deploy reverts to it` | KEEP | An explicit RESET_REF rollback to a SHA becomes the durable successful release, and a later unhealthy deploy reverts to it. Catches using the current checkout/branch instead of last-success state across deployments; a single fresh deploy cannot detect that history dependency. |
| `an unknown ref fails before touching the tree` | KEEP | An unknown target ref must fail while HEAD and restart history remain unchanged. Catches destructive checkout/restart before validation; build failures assume the requested commit exists. |

## `scripts/check-changed.test.mjs`

1. **Independent contract:** AGENTS.md pnpm check:changed sibling selection, dependent typechecks, package-own runner/setup/limits; script CLI documented planning contract.
2. **Recognizable failure:** Individual rows below state the broken caller-visible outcome.
3. **Independent oracle:** Authored fake file tree, literal selected files/filter arguments and shell-parsed argv for apostrophe/space filename plus known env limits.
4. **Stable seam:** Changed-file selection, runner parsing, typecheck/test plans; generated commands executed by real sh with node argv recorder.
5. **Refactor resistance:** Assertions observe the stated data, process result, public command plan or platform API behavior rather than private collaborator order or source identifiers. Rewritten worker cases enter through registered browser events; command planning checks actual shell argv, so helper names and quote spelling may change.
6. **Unique protection:** Selection/deletion, parsing, dispatch and affected typechecks differ. planTests now owns package-prefix rejection and shell operand integrity, so the two private helper tests/exports disappear.

Production callers: Root pnpm check:changed CLI. Risk: Medium.
Validation: `node --test scripts/check-changed.test.mjs`.

| Baseline test | Disposition | Evidence / surviving owner |
| --- | --- | --- |
| `selectTests: changed tests, and the tests and checks beside a changed file` | KEEP | A literal fake repository tree and changed-file list yield independently enumerated sibling tests/checks while excluding similar prefixes. Catches silently omitted regression targets or unrelated work; command planning accepts an already selected list. |
| `selectTests: a deleted test is skipped; a deleted source still selects its sibling test` | KEEP | A deleted test is omitted, but a deleted production file still selects its surviving sibling; missing directories are tolerated. Catches CI failure on removed paths or missed deletion regressions; normal-tree selection cannot expose absent entries. |
| `packageOf picks the package that contains a path, or null` | CONSOLIDATE (removed) | Private path-matcher test removed; planTests now includes apps/daemonic/a.test.ts beside apps/daemon and proves it stays in root dispatch. Existing package/root entries prove normal ownership. Surviving owner: `scripts/check-changed.test.mjs: planTests groups files per package with its runner, root last, and reports unrunnable ones`. |
| `runnerOf takes the package's own node --test preamble` | KEEP | Checks literal runner commands including timeout/concurrency retention, setup prefix, and removal of test flags for checks. Removes expectations derived via runnerOf itself. Catches focused checks losing native preparation or passing --test flags to standalone scripts. |
| `planTests groups files per package with its runner, root last, and reports unrunnable ones` | CONSOLIDATE | Surviving public command-plan owner absorbs path-prefix and shell quoting protection. Real sh determines argv, independently checking whitespace/apostrophe operand, timeout/concurrency expansion, checks without --test, cwd groups and root-last order without locking quote spelling. |
| `planTypecheck: affected packages and dependents, all for a root input, none otherwise` | KEEP | Literal changes yield pnpm filters for affected packages plus dependents, all packages for root config, and none for unrelated files. Catches skipped dependent typechecks or unnecessary broad work; test selection protects a different gate. |
| `shellQuote survives quotes and spaces` | CONSOLIDATE (removed) | Private exact POSIX quote-spelling test removed; surviving planTests passes a filename containing both apostrophe and whitespace through real sh and checks one intact argv operand. Surviving owner: `scripts/check-changed.test.mjs: planTests groups files per package with its runner, root last, and reports unrunnable ones`. |

## `scripts/deploy-public-url.test.mjs`

1. **Independent contract:** deploy/README.md configured public origin, preserve existing value, safe domain validation and mode0600.
2. **Recognizable failure:** Individual rows below state the broken caller-visible outcome.
3. **Independent oracle:** Literal URL/config bytes/status; unchanged contents after existing override or injection refusal; POSIX file mode.
4. **Stable seam:** Actual Bash helper execution and temporary daemon.env bytes/mode.
5. **Refactor resistance:** Assertions observe the stated data, process result, public command plan or platform API behavior rather than private collaborator order or source identifiers. Rewritten worker cases enter through registered browser events; command planning checks actual shell argv, so helper names and quote spelling may change.
6. **Unique protection:** Missing/add, existing/preserve and missing/unsafe-domain refusal are separate states. Deployment orchestration stubs do not own this config mutation.

Production callers: remote-update.sh and remote-provision.sh. Risk: High.
Validation: `node --test scripts/deploy-public-url.test.mjs`.

| Baseline test | Disposition | Evidence / surviving owner |
| --- | --- | --- |
| `adds ORQUESTER_PUBLIC_URL from the domain when the file has none` | KEEP | Actual Bash execution appends the literal HTTPS public origin, handles a missing final newline, remains idempotent and preserves mode 0600. Catches invalid env files, lost daemon addressing or exposed secrets; source command greps cannot prove file behavior. |
| `never overwrites an existing value` | REWRITE | Actual helper still must succeed and leave operator-provided daemon.env byte-for-byte unchanged. Removes incidental already-set stdout wording. |
| `does nothing without a domain, and refuses a domain that could inject` | KEEP | An empty domain leaves the real file unchanged, and shell-syntax input fails without mutation. Catches unintended config writes or unsafe target-domain acceptance; valid-domain insertion cannot protect refusal. |

## `scripts/ensure-node-native.test.mjs`

1. **Independent contract:** README and deploy/README.md Node-vs-Electron ABI guard; ensure-node-native CLI contract only rebuild failing modules once and verify load; pnpm store hardlink isolation.
2. **Recognizable failure:** Individual rows below state the broken caller-visible outcome.
3. **Independent oracle:** Authored load-error queues and rebuild effects; actual missing module error; independent inode/content/mode and later in-place write.
4. **Stable seam:** Native guard result/rebuild dependency boundary, actual child probe, actual hardlinked build files.
5. **Refactor resistance:** Assertions observe the stated data, process result, public command plan or platform API behavior rather than private collaborator order or source identifiers. Rewritten worker cases enter through registered browser events; command planning checks actual shell argv, so helper names and quote spelling may change.
6. **Unique protection:** No-op/selective/all-broken/unrepaired/false-rebuild-code states differ; real child-probe and filesystem hardlink correctness cannot be replaced by pure decision tests. Probe sequence and batching representation are removed.

Production callers: Desktop build:electron, package daemon test preparation and deployment scripts. Risk: High.
Validation: `node --test scripts/ensure-node-native.test.mjs`.

| Baseline test | Disposition | Evidence / surviving owner |
| --- | --- | --- |
| `does nothing when every module loads` | REWRITE | Retains no-op public result and zero rebuilds; removes exact probe-name/call-order array because an equivalent implementation may probe differently. |
| `rebuilds only the failing module, once, then re-checks it` | REWRITE | Retains selective rebuild and independently expected repaired result; removes incidental probe call sequence while still detecting rebuilding a healthy dependency or missing failed module. |
| `rebuilds all failing modules in a single call` | REWRITE | Renamed rebuilds every failing module; verifies both modules are rebuilt and result succeeds, allowing equivalent batching/order instead of specifying private single-call shape. |
| `still broken after rebuild: not ok, and main exits non-zero with the reason` | KEEP | A module still failing after rebuild causes CLI exit 1 and names the module/cause. Catches restarting a daemon that cannot load its native ABI; successful recovery cases cannot protect this release gate. |
| `a rebuild that reports failure but fixes the module still passes` | KEEP | When pnpm reports failure but the independent second load probe succeeds, main returns 0. Catches falsely blocking a repaired install based solely on installer status; persistent-failure and successful-installer cases do not establish the loadability authority. |
| `the real child probe reports load success and failure` | KEEP | Runs the real child-process probe with a builtin success and deliberately missing module, requiring the actual load error. Catches broken child spawn/status/stderr interpretation; injected probes in decision tests intentionally bypass this process boundary. |
| `detachBuildFiles gives hard-linked build files their own inode, content and mode intact` | KEEP | Real hardlinked addon bytes are detached, mode/content preserved, and later in-place writes cannot change the store; unrelated files remain linked and repeat invocation is harmless. Catches Electron rebuild poisoning pnpm shared binaries across checkouts; load probes alone cannot detect future shared-store corruption. |

## Completed local verification

- `node --check apps/web/test/sw.test.mjs && node --check scripts/check-changed.test.mjs` — passed.
- `git diff --check -- apps/box-agent apps/web scripts deploy` — passed.

No test run is claimed by this workstream yet: root schedules package/full-suite verification in the single worktree test slot. Baseline cross-platform build timing is the only performance value recorded here; no before/after speedup is claimed.

Root `pnpm check:changed` executed the four root/deploy test files successfully (1.3s) and the changed box-agent fixture file successfully (0.9s). Its worker run exposed a fixture omission: entering the browser fetch handler requires timer globals, which the former private-helper tests never supplied. The VM now supplies host `setTimeout`/`clearTimeout`, with controlled-clock overrides preserved. Worker rerun is pending the central slot.
