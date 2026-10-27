# Knowledge and desktop test audit

Scope: all 41 test files under `apps/daemon/src/knowledge/` and `apps/daemon/src/desktops/`: 341 baseline named test registrations. Outcomes: 328 KEEP, 7 REWRITE, 3 CONSOLIDATE, 3 DELETE; 335 final registrations. No test was disabled or moved out of the required suite.

Every row below inherits its file’s independent source, oracle, stable seam, refactor resistance and unique failure rationale. Its name specifies the exact individual contract and recognizable failure (the opposite result); protocol cases with short names inherit the independently encoded field-format oracle. The JSON companion preserves baseline path/line/name identities and evidence references.

Cleanup: remove private account-chain matrix, repeated fake-myKG scenarios, generic plugin-setting duplicate; internalize `knowledgeWorkerChain` and `DEFAULT_KNOWLEDGE_MODEL` (no outside production imports). No fixture/snapshot/dependency was orphaned: fake-myKG remains used by retained service, runner and end-to-end tests; the Opus capture fixture remains used by splitter/audio contracts. Production runtime logic is unchanged.

Performance: retained 5,000-entry p95 search check because the design explicitly specifies 300 ms at that scale; retained the 65,536-request X11 sequence-wrap check because protocol wrap cannot be exercised by smaller request counts without a new test-only production hook. Real desktop/audio integrations and opt-in model/network installers uniquely verify external tool composition. Ordinary tests use controlled clocks, event drains and temporary isolated resources. No speedup is claimed from source inspection. Baseline/final measured timings and central validation are recorded by the root audit report.

Isolated unchanged service diagnostic passed all 20 tests in 3010.9 ms: `TSX_DISABLE_CACHE=1 node --import tsx --test --test-isolation=none --test-timeout=15000 --test-reporter=spec src/knowledge/linking/service.test.ts` (daemon cwd). The suspected baseline stall did not reproduce; no service change was made. Modified-file validation pending central test slot. Intended focused command (daemon cwd): `TSX_DISABLE_CACHE=1 node --import tsx --test --test-concurrency=4 src/knowledge/linking/daemon-workers.test.ts src/knowledge/linking/runner.test.ts src/knowledge/install/plugin.test.ts src/knowledge/store/store.test.ts src/desktops/x11/connection.test.ts src/knowledge/linking/inbox.test.ts src/knowledge/linking/workers.test.ts src/knowledge/settings.test.ts src/workflows/agent/select.test.ts`. Root owns full-suite/typecheck gates.

## desktops/audio.test.ts

**Independent source:** docs/superpowers/specs/2026-09-30-desktop-tab-design.md §8.

**Regression/unique owner:** Dropped/framing-corrupted Opus, duplicate encoders, ignoring backpressure, runaway retry or child leak. Splitter tests do not exercise encoder/sink ownership; the PulseAudio integration uniquely checks the real capture command.

**Independent oracle:** Captured ffmpeg fixture digest, literal framed sequence bytes, sink state and child signals.

**Stable seam:** DesktopAudioHub.subscribe/stopDesktop/shutdown and actual child-exit events. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/desktops/audio.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| no ffmpeg: the sink hears audio unavailable and nothing spawns | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| one encoder per desktop: framed packets with seq fan out; a backed-up sink is skipped | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| an encoder that keeps failing restarts with backoff, then reports unavailable with the reason | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| stopDesktop and shutdown kill encoders now; shutdown refuses new subscribers | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| integration: a tone in the desktop's sink arrives as Opus packets; the encoder stops after the grace | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## desktops/desktop-manager.integration.test.ts

**Independent source:** docs/superpowers/specs/2026-09-30-desktop-tab-design.md §13.4 and AGENTS.md session ownership/privacy.

**Regression/unique owner:** Broken shell script/manager/tmux/X11 composition, daemon reattach losing apps, exposed launch secrets or orphaned process groups. Lower tests fake these boundaries.

**Independent oracle:** Observed window/app status, exit code 3, absence of secret argv and surviving process groups.

**Stable seam:** DesktopManager lifecycle over a private tmux server and real Xvnc/Openbox/xterm. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/desktops/desktop-manager.integration.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| 1. create a desktop; it becomes running | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| 2–3. xterm's window appears with its appId; closing it exits the app, not the desktop | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| 4. an app exiting with 3 is exited with code 3; no argv ever held a command or env value | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| 4b. an app gets the plugins' NODE_OPTIONS preload after its own NODE_OPTIONS, only while one is active | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| 5. a second manager over the same appdir reattaches the running desktop and its apps | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| 7. stopping the desktop leaves no process of its groups behind | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| restart, a host crash (Xvnc killed) and close | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## desktops/host-env.test.ts

**Independent source:** docs/superpowers/specs/2026-09-30-desktop-tab-design.md §5.3/§5.5.

**Regression/unique owner:** Secret/Wayland/tmux inheritance, wrong display/audio sockets, shell expansion or readonly-variable poisoning. A real shell round trip owns quoting; integrations do not enumerate malicious values.

**Independent oracle:** Literal environment keys, known paths and values read back by real sh.

**Stable seam:** Environment and shell-file builders consumed by desktop-host.sh/app-run.sh/PulseAudio. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/desktops/host-env.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| app env: scrubs tmux, ORQUESTER_* and Wayland from the base, adds the desktop wiring | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| app env: software GL only without a render node | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| app env: LP_NUM_THREADS from the desktop, the user's value wins | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| socket dir fallback above 100 bytes | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| default.pa loads one native socket, the orq null sink as default | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| env file round-trips nasty values through a real sh unchanged | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| env file never writes app-run.sh's own names or bash read-only variables | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## desktops/host-status.test.ts

**Independent source:** docs/superpowers/specs/2026-09-30-desktop-tab-design.md §4.

**Regression/unique owner:** False capability detection, accepting non-executable tools or unavailable hosts without actionable dependency hints. Integration requires installed tools and cannot own missing-tool branches.

**Independent oracle:** Trimmed ffmpeg 6.1.1 outputs, literal required package commands and isolated executable files.

**Stable seam:** DesktopHostProbe.status plus ffmpeg-output parsers and executable resolution. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/desktops/host-status.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| ffmpeg pulse input: needs the D flag on the pulse row | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| ffmpeg libopus encoder: the native opus encoder is not enough | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| install hint lists only the missing packages, in the spec's order | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| resolveTool finds executables on the given PATH only | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a host without the tools is unavailable with an install hint | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## desktops/http-routes.box.test.ts

**Independent source:** docs/superpowers/specs/2026-09-30-desktop-tab-design.md §7.1 plus AGENTS.md filesystem containment and remote auth boundaries.

**Regression/unique owner:** Resolving a VM path on the host, path escape, accepting disconnected/unsupported VMs or mismatched desktop location. Host HTTP tests do not enter box paths.

**Independent oracle:** HTTP statuses/codes, real symlink containment and recorded launch input in a temp project.

**Stable seam:** Fastify desktop routes through a production BoxRegistry/BoxConnection boundary. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/desktops/http-routes.box.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| host status: a box project's is its VM's; a host project's and the bare route stay the host's | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| create in a Linux box project: the project and the first app's cwd are realpath'd and contained in the box | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a box project whose VM is not connected answers 409 BOX_NOT_READY | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| macOS and Windows box projects are refused: no desktop, no suggestions, a status saying why | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a VM desktop's app cwd is checked in its VM; a desktop that runs elsewhere than its project is refused | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| suggestions of a VM project are the VM's: its user's .desktop apps and the project's executables there | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## desktops/http-routes.test.ts

**Independent source:** docs/superpowers/specs/2026-09-30-desktop-tab-design.md §7.1 and AGENTS.md auth/containment/secret rules.

**Regression/unique owner:** Missing auth/containment, wrong cwd resolution, malformed env accepted or secrets echoed. Manager tests bypass route parsing/auth and cannot replace these checks.

**Independent oracle:** Literal HTTP statuses, error codes, forwarded normalized user inputs and denied side effects.

**Stable seam:** Real createServer HTTP injection with desktop service dependency isolated. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/desktops/http-routes.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| create: projectPath outside the sandbox is 403 and never reaches the manager | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| create: a missing project directory is 400 | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| create: keeps the client's projectPath beside its realpath; a first app's relative cwd resolves against the project | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| create: 409 DESKTOP_UNAVAILABLE carries the install hint | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| launch: cwd escaping the sandbox is 403 | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| launch: defaults cwd to the project | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| launch: command and env validation (400), never echoing a value | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| unknown desktop ids are 404 | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| restart of a running desktop is 409 | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| app log is text/plain | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| window action must be activate, maximize or close | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| list: projectPath is sandboxed and realpath'd; omitted lists all | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| suggestions need a sandboxed projectPath | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| remote transport: desktop routes need the bearer | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## desktops/manager.box.test.ts

**Independent source:** docs/superpowers/specs/2026-09-30-desktop-tab-design.md lifecycle/reattach contracts, API DesktopSummary.box and AGENTS.md process ownership.

**Regression/unique owner:** Installer completion undoing stop, reconnect misclassifying a live app, reboot signalling a reused PID, failed startup leaving a host alive or lack of owner checks. Local manager/X11 tests do not exercise box link transitions.

**Independent oracle:** Public status, persisted box record, actual ready/exit files and owner-checked signal data.

**Stable seam:** DesktopManager with production LocalDesktopHost filesystem plus an independently controlled box link/tmux. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/desktops/manager.box.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| a VM desktop whose stack is missing installs it first, its progress in statusDetail, then runs in the box | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| an install that cannot happen drops the tab again and answers 409 with its hint | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a VM that is not connected refuses new desktops and stops, but not closes | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a restart whose install fails leaves the desktop failed with the reason and its hint | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a VM desktop on a daemon without VM support ends stopped at boot, its record kept | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a VM missing only optional packages (sound, a compositor) gets them on the first desktop | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a stop while the VM installs is not undone when the install ends | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a link blip while the VM installs leaves the install in charge: the desktop then starts | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| an app launched while the reconnect reconcile reads the VM is not taken for exited | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a VM that restarted while out of reach: its running desktop ends stopped, saying so, and no reused pid is signalled | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a VM shut down cleanly while out of reach (its host's trap wrote host.exit): the reconnect says it restarted, not that the host crashed | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a link blip without a restart: the desktop stays running, reconciled again | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a host that came up after its start timed out on a dropped link is killed on the next connect; the desktop stays failed | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| every signal into a VM carries the owner check: app stops, teardown, the host's group | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## desktops/manager.test.ts

**Independent source:** AGENTS.md asynchronous event ordering and docs/superpowers/specs/2026-09-30-desktop-tab-design.md app exit contract.

**Regression/unique owner:** Publishing exited before its code has been ingested. The real stack integration checks final state and would miss this transient inconsistent summary.

**Independent oracle:** Every sampled exited summary must contain code 3 from the file.

**Stable seam:** DesktopManager.get/updated while a real atomic exit file is ingested. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/desktops/manager.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| an app's exit is never seen as exited without its code: every summary sampled while it lands | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## desktops/ogg-opus.test.ts

**Independent source:** docs/superpowers/specs/2026-09-30-desktop-tab-design.md §8.1; RFC 3533 Ogg lacing and RFC 6716 Opus packet framing.

**Regression/unique owner:** Lost/duplicated packets under arbitrary chunk boundaries, corrupted continuation/resynchronization or header leak. Encoder fanout tests only exercise the captured fixture layout.

**Independent oracle:** Independent captured-page bodies and literal packet buffers, including 255-byte lacing.

**Stable seam:** OggOpusSplitter.push over captured bytes and independently encoded pages. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/desktops/ogg-opus.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| fixture: header packets skipped, one 10 ms audio packet per page | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| fixture: 1-byte and odd-sized chunking give identical output | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| garbage before, between and inside pages resyncs on the next capture pattern | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a packet laced with 255s continues across segments and across pages | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a lost page drops only the packet it truncated | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a new stream (BOS) restarts header skipping | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## desktops/reconcile.test.ts

**Independent source:** docs/superpowers/specs/2026-09-30-desktop-tab-design.md §5.6 and AGENTS.md persisted-record tolerance/session ownership.

**Regression/unique owner:** Trusting stale disk status, ignoring exit files or reaping a session whose record was unreadable. Manager integration does not enumerate all crash/recovery combinations.

**Independent oracle:** Handwritten statuses, exit codes and exact session IDs eligible for reaping.

**Stable seam:** Pure reconcile boundary: persisted records plus independent live-session/window/ready/exit observations. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/desktops/reconcile.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| record + live session + ready + no host.exit → running; apps by window / exit file / neither | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| record without a live session → stopped; apps exited (exit file code or null) | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| live session whose host exited, never became ready, or lost its host window → stopped, session killed | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| live session without a record is reaped only when the index loaded | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a live session whose record this build could not read is never reaped | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## desktops/store.test.ts

**Independent source:** docs/superpowers/specs/2026-09-30-desktop-tab-design.md §9; AGENTS.md unknown records/fields and atomic persistence.

**Regression/unique owner:** Overwriting unreadable state, dropping newer data, insecure permissions or out-of-order writes. Config schema tests do not own filesystem/quarantine/write sequencing.

**Independent oracle:** Literal input records/unknown fields, file modes, quarantined originals and final snapshot IDs.

**Stable seam:** DesktopStore.load/persist over real temporary files. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/desktops/store.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| a missing file is an empty index that loaded cleanly; writes are 0600 | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| rejected records and unknown keys are written back verbatim | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| an outer-shape failure is quarantined and the store goes read-only | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| unparseable JSON is quarantined too | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| an unreadable file is left alone: read-only, not loaded | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| chained writes land in order: the last snapshot wins | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## desktops/suggestions.test.ts

**Independent source:** docs/superpowers/specs/2026-09-30-desktop-tab-design.md §7.1 and freedesktop Desktop Entry Exec/group/visibility semantics.

**Regression/unique owner:** Launching action/localized entries, retaining field-code placeholders, ignoring user overrides, traversing excluded directories or returning unbounded suggestions. HTTP box test owns remote transport, not parser/discovery combinations.

**Independent oracle:** Handwritten launchable/hidden files, literal commands, override precedence and bounded executable results.

**Stable seam:** Desktop Entry parsing/scanning and project executable discovery. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/desktops/suggestions.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| Exec field codes are stripped, %% kept as % | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| desktop entry: Name/Exec/Icon from [Desktop Entry] only | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| desktop entry: NoDisplay, Hidden, Terminal, non-Application and incomplete entries are skipped | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| scan: a user file overrides (or hides) the system file of the same name | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| project executables: root, bin/ and build/**/bin/ up to depth 4 | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| project executables are capped | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## desktops/windows.integration.test.ts

**Independent source:** docs/superpowers/specs/2026-09-30-desktop-tab-design.md §6.2; EWMH/X11/X-Resource protocol.

**Regression/unique owner:** Bad EWMH messages, wrong XRes PID attribution, failed reconnect/action or ignored root resize. In-memory protocol tests cannot prove interoperability with the server/window manager.

**Independent oracle:** Actual window titles/classes, owning process IDs, active/maximized state, child exits and resize events.

**Stable seam:** DesktopWindowTracker public action/events/snapshot against real Xvnc/Openbox/xterm. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/desktops/windows.integration.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| the server refuses connections without the cookie or with a wrong one | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| windows appear with their app, title and class | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| activate switches the active window | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| maximize toggles | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| refreshApps re-resolves the app mapping | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| reconnects after the connection drops | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| close asks the app to close; the window goes and the app exits | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a root resize emits resize | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| gives up and emits error when the display is gone for good | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## desktops/windows.test.ts

**Independent source:** docs/superpowers/specs/2026-09-30-desktop-tab-design.md §6.2; Linux /proc stat layout and API window-ID/action contracts.

**Regression/unique owner:** Misparsing comm parentheses, associating descendants with the wrong app, looping on vanished/cyclic process data, invalid window IDs or startup failures hidden. Integration does not provide these controlled process trees/failures.

**Independent oracle:** Known proc records and process groups, literal app IDs, typed window errors.

**Stable seam:** Proc stat parsing, public PID-to-app mapping and DesktopWindowTracker startup/action failures. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/desktops/windows.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| parseProcStat reads ppid and pgrp after a comm with spaces and parentheses | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| readProcStat reads this process and returns null for a missing pid | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| appForPid: the process's own group matches | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| appForPid: walks ancestors whose groups differ (a child that made its own group) | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| appForPid: unmatched up to pid 1, a vanished process, and a ppid cycle all give null | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| window ids are 0x-prefixed lowercase hex | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| start rejects when the display is unreachable; actions on unknown windows throw DesktopWindowNotFoundError | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## desktops/ws-routes.test.ts

**Independent source:** docs/superpowers/specs/2026-09-30-desktop-tab-design.md video/audio WebSocket contract; RFC 6455; AGENTS.md auth.

**Regression/unique owner:** Unauthenticated access, pre-connect bytes lost/reordered, ping leaking into RFB, pong bypassing queued video or leaked audio subscriptions. Hub/manager tests bypass WebSocket framing and upgrades.

**Independent oracle:** Literal close codes and frame bytes, independently emitted audio state/packets and ordered binary payloads.

**Stable seam:** Real Fastify/WebSocket upgrades and Unix-stream relay. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/desktops/ws-routes.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| both routes reject a missing or invalid token with 1008 after the upgrade | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a desktop that isn't running closes with 1011 | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| RFB relay round trip: binary both ways, either side closing closes both | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| bytes sent before the upstream connects are delivered in order | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| ping is answered with pong on the same socket, queued behind RFB data already sent | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| audio route: state message first, then framed packets; ping/pong; close unsubscribes | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| audio route: sink.close (desktop stopped) closes the socket with 1011 | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| audio route: running without audio sends state unavailable and stays open for pings | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## desktops/x11/connection.test.ts

**Independent source:** docs/superpowers/specs/2026-09-30-desktop-tab-design.md §6.2; X11 request sequencing/framing/error protocol.

**Regression/unique owner:** Wrong reply/error correlation across 16-bit wrap, partial event mishandling, unresolved closed requests, oversized buffer allocation or swallowed void-request errors. Protocol encode/decode unit tests do not own stateful sequencing.

**Independent oracle:** Hand-encoded replies/errors/events and literal roots/atoms/error classes.

**Stable seam:** X11Connection over an independently driven Duplex server stream. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/desktops/x11/connection.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| handshake exposes the root and rejects a refusal with the reason | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| handshake fails when the stream closes first | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| replies resolve the request with the matching sequence number | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| an error rejects only its own request | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| void requests are checked through a GetInputFocus sync | REWRITE | Failed refactor-resistance/private-shape assertions replaced by successful selectInput completion and typed error with server-supplied bad window. Fake server answers whichever synchronization query is chosen. Survives as “void requests resolve after processing and reject their own server error”. |
| sequence numbers widen across the 16-bit wrap | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| GetProperty reads a long value in chunks | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| GetProperty returns null for a missing property | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| events split across chunks are dispatched whole | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| an unexpected close rejects pending requests and reports the error | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a reply declaring more than the cap closes the connection instead of buffering it | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| close() reports a null error | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## desktops/x11/protocol.test.ts

**Independent source:** docs/superpowers/specs/2026-09-30-desktop-tab-design.md §6.2; X11/X-Resource binary protocol.

**Regression/unique owner:** Wrong opcode/endianness/padding/field offsets, unsigned coordinates, truncation accepted or missing property values. Stateful connection tests do not enumerate these record formats.

**Independent oracle:** Fixed hexadecimal protocol vectors, independently built server records and literal decoded fields.

**Stable seam:** Request encoders and reply/event decoders used by X11Connection. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/desktops/x11/protocol.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| setup request carries the byte order, version 11.0 and padded auth | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| InternAtom pads the name and sets only-if-exists | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| GetProperty | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| ChangeWindowAttributes sets only the event mask | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| GetGeometry and QueryExtension | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| SendEvent wraps a format-32 ClientMessage | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| X-Resource QueryVersion and QueryClientIds with the pid mask | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| success: ids, vendor and every screen's root and size | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| failure carries the server's reason | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| authenticate | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| framing: events and errors are 32 bytes, replies and generic events carry a length | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| error | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| PropertyNotify, including one delivered by SendEvent | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| ConfigureNotify with signed position | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| DestroyNotify and unknown events | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| replies: InternAtom, QueryExtension, GetGeometry | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| GetProperty reply: format 8 and 32 values, missing property | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| property strings split on NUL | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| QueryVersion | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| QueryClientIds: pid value | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| QueryClientIds: no pid known, several ids, truncation | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## desktops/x11/xauth.test.ts

**Independent source:** docs/superpowers/specs/2026-09-30-desktop-tab-design.md X authority isolation; Xauthority file format.

**Regression/unique owner:** Wrong cookie/display chosen, malformed authority accepted, insecure/reused cookie file. Real X11 integration only checks one generated authority against a server.

**Independent oracle:** Fixed big-endian byte vector, literal cookie selection, real 0600 file mode and distinct regenerated bytes.

**Stable seam:** Xauthority binary parser/encoder, cookie selection and private-file replacement. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/desktops/x11/xauth.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| parses the single FamilyWild entry the daemon writes | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| picks the first MIT cookie whose number is empty or the display | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| rejects a truncated file and accepts an empty one | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| replaces the authority file with a private wildcard cookie readable on any display | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## knowledge/e2e-tools.test.ts

**Independent source:** docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md Agent tools, Collections and profiles, Indexing on the subscription.

**Regression/unique owner:** A real composition/principal/manifest/worker-tool wiring error despite passing module tests; edits/deletes wrongly advertised or scoped. This uniquely crosses those production modules; lower tests isolate different dependencies.

**Independent oracle:** User-supplied entries and collections, visible/hidden IDs, persisted mirror bytes, tool outcomes and loaded graph concepts.

**Stable seam:** Catalog executor → InjectDaemonApi → real KnowledgeService/routes/store/search/linking/profile/worker tools. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/e2e-tools.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| knowledge tools end to end: save from Global and profile chats, visibility in search and get, relabel, delete, manifests, the plugin switch, and a linking run through the worker tools | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| knowledge_update and knowledge_delete end to end: edits by collection name, clearing a field, visibility, per-id delete outcomes, and who is advertised them | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## knowledge/install/installer.test.ts

**Independent source:** docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md Install and updates, Prompt overlay, Privacy; pinned uv/myKG/tiktoken formats.

**Regression/unique owner:** Executing unverified binaries, overwriting working runtime after failure, leaking daemon env, wrong lock/model/encoding/overlay packaging or fetching a tokenizer at runtime. Plugin orchestration tests do not own each installer safety step.

**Independent oracle:** Literal archive hashes, pinned release URLs/cache keys, real files and named failed steps.

**Stable seam:** Runtime installer filesystem/download/process ports and shipped configuration artifacts. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/install/installer.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| the pinned release installs from the hashed lock into versions/<v>/ with the overlay, the model and a manifest | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a newer patch installs its wheel by sha256; every other package by the pinned lock's hashes | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| tar unpacks uv with the runtime's env too, not the daemon's | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| uv must match both Orquester's pin and the release's published sha256 | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a myKG that renamed a prompt fails the install at the overlay, before anything is copied | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| each failing step is named and leaves versions/ as it was | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a myKG that rejects the generated config fails the install at the smoke test, naming why | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| the config check refuses a tokenizer download before its downloader runs | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| the pinned encodings are the one the generated config loads, under tiktoken's cache names | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a leftover dir of the same version is replaced; a cancelled install leaves nothing | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| an invalid release is refused before anything is downloaded | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| readiness: the manifest, the entry points, every model file, and (when asked) the shipped overlay and encodings | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| prune keeps only the named versions | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| latest is the newest usable patch of the pinned minor line; the pin resolves offline | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| the uv pins: one build per supported host, none elsewhere | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| the shipped lock pins the pinned myKG by its wheel hash and every dependency by version | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## knowledge/install/live.test.ts

**Independent source:** docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md Install and updates / private runtime.

**Regression/unique owner:** Vendor wheel/runtime/relocation incompatibility invisible to fake uv/dependency tests. Opt-in live prerequisite retained; no claim it ran in ordinary suite.

**Independent oracle:** Actual executable/config success, known pinned hashes and absence of host HOME pollution.

**Stable seam:** Real network install into a temporary runtime, relocation and real Python/myKG commands. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/install/live.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| live: the pinned runtime installs, relocates and runs | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## knowledge/install/overlay.test.ts

**Independent source:** docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md Prompt overlay and pinned myKG 0.4 prompt paths/append headers.

**Regression/unique owner:** Prompt copy applied to incompatible vendor layout, partial copy before validation, losing appended-input headers or unchanged digest after content/path edits. These are external package bytes/paths, not identifier/source inventories.

**Independent oracle:** Literal vendor-relative paths and required SOURCE TEXT/SCHEMA headers; changed file bytes/paths and missing targets.

**Stable seam:** Shipped prompt files and overlay filesystem API. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/install/overlay.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| the 0.4 overlay replaces the domain-specific prompts, all of them files myKG 0.4 ships | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| the overlay retains the headers myKG appends its input blocks after | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| apply refuses a package without a target file and copies nothing; then copies every file | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| the digest covers paths and bytes | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## knowledge/install/plugin.test.ts

**Independent source:** docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md Install and updates/settings plugin lifecycle.

**Regression/unique owner:** Wrong initial release, rollback/retry/repair state, cross-plugin job coupling, working runtime discarded or stale runtime port. Installer unit tests do not drive persisted plugin state and runtime tracker transitions.

**Independent oracle:** Current/previous/skipped versions, literal errors/steps and actual retained/deleted runtime files.

**Stable seam:** PluginsService knowledge updater plus KnowledgeRuntimeTracker over real temp files and isolated network/process ports. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/install/plugin.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| off by default, no installed version or active job; nothing fetched | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| turning it on installs the pinned runtime in its own lane; the runtime port follows | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| the first install is the pinned version even when PyPI has a newer patch; the next check offers that | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| checks offer newer patches of the pinned line only; updates keep current and previous | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| rollback swaps current and previous and skips the version rolled back from | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a previous version installed with an older overlay is still a rollback target; the next check repairs it | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| an update over a current version with an older overlay keeps it as the rollback target | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a failed install records its step and version; the hourly check does not retry it, a manual one does | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a first install that failed is retried by the hourly check | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a myKG that rejects the generated config records a smoke-test error and keeps the working version | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a runtime missing its tiktoken encoding is repaired by the next check | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| remove downloads is refused while on, then deletes the runtime and keeps the settings | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a runtime whose files vanished is repaired by the next check; the port drops it meanwhile | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| the hourly timer runs for Knowledge Graph alone, and only while it is on | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| an unsupported host: no turning on, no checks | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| settings live on the record: merged, unknown keys kept, unreadable state never written | DELETE | Failed unique-protection bar: generic PluginsService settings merge, not knowledge updater behavior; knowledge/settings.test.ts update persistence/unknown-field tests own the same record. Name claimed unreadable-state check absent from body. |

## knowledge/linking/daemon-workers.test.ts

**Independent source:** docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md Indexing on the subscription and Accounts/settings migration.

**Regression/unique owner:** Ignoring live account policy/model, launching outside the managed indexer profile, treating profile failure as account failover, double-counting cached tokens or failing to close tabs. Workflow selection owns algorithms; this owns knowledge-specific adapter wiring.

**Independent oracle:** Literal selected account/model, explicit launch ownership/profile, typed fatal/nonfatal refusals and known token sums.

**Stable seam:** WorkerSessionPort.pick/start/usage/stop through the production DaemonApi boundary. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/linking/daemon-workers.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| one Claude entry carrying the settings' policy as it is, Sonnet by default | REWRITE | Helper export/shape assertions replaced by public WorkerSessionPort.pick; it must choose c2/Sonnet then c1/Opus after a live settings edit. Unique knowledge wiring survives; helper/model exports internalized. Survives as “picks from the current account policy with Sonnet by default and the configured model after an edit”. |
| legacy automatic (no record, accountId null): the least used Claude account; the System login only without any | CONSOLIDATE | Failed unique-protection bar: settings.test.ts owns legacy automatic/System policy migration and workflows/agent/select.test.ts owns least-used/System choice. Public worker pick owner keeps the knowledge adapter boundary. |
| a legacy chosen account goes first, every other Claude account after it (failover) | CONSOLIDATE | Failed unique-protection bar: settings.test.ts a legacy accountId reads as the policy it meant owns migration/order; workflows/agent/select.test.ts owns fixed selection. Worker pick owner retains forwarding. |
| each strategy, the allow-list, the caps and unknown usage choose as a workflow Agent block does | CONSOLIDATE | Failed unique-protection bar: workflows/agent/select.test.ts directly owns fixed/least-used/soonest-reset, caps, allowlists, unknown usage and System semantics; private helper matrix adds no failure mode. |
| creates an unattended, full-access chat the indexer owns, in the empty workers dir, with the managed profile | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a refused create passes the account over; a profile that cannot be prepared is fatal | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| counts every input token of the chat's turns once (cached and cache writes are inside inputTokens) and closes the tab | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## knowledge/linking/inbox.test.ts

**Independent source:** docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md worker tools; pinned myKG agent_adapter.py task/outbox protocol.

**Regression/unique owner:** Duplicate leases/answer writes, incomplete outbox publication, ignored watcher tasks, instruction duplication, invalid JSON accepted, leaked parked calls or lost cached answers. Worker/service tests cannot replace lowest broker protocol edge ownership.

**Independent oracle:** Independent task envelopes, literal task/answer IDs/data, atomic file operation order and public lease/budget results.

**Stable seam:** InboxBroker next/submit/release/finish over actual task/answer files, clock and fs.watch. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/linking/inbox.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| accepts JSON, trimmed, with or without a ```json fence | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| refuses prose, half JSON and bare values with the parse error | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| sends a step's instructions once per chat, then points at the task they came with | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| refuses an answer that does not parse and keeps the task with the chat to redo it | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| writes the answer (temp + rename) strictly before the .done marker | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| leases a task to one chat and hands a released chat's task to the next asker | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| an answer already given (by another chat) is accepted without a second write | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| skips tasks myKG already has answers for (a resumed run) | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| answers a name-normalization task from an earlier answer to the very same prompt, whatever its batch label | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| retires a chat at its task budget | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| retires a chat whose context estimate passed the token budget | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| holds a call until a task appears, and says done when the run ends | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| wakes a waiting chat from the inbox watcher (fs.watch), no rescan asked | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a broker disposed while it is still attaching (the run ended at once) opens no watcher | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| retires a chat that waited the whole long-poll with nothing to do | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| answers run-cancelled once cancelled, and refuses an unknown task | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| counts demand as the pending tasks no waiting chat will take | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| removes the task files no answer was written for, and keeps every answer (the cache) and answered task | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a session without an inbox yet clears nothing | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## knowledge/linking/indexer-profile.test.ts

**Independent source:** docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md indexing chats cannot wander; managed profile requirements.

**Regression/unique owner:** Indexer receives user tools/context or managed profile rewrites on every ensure. Worker launch test only checks profile ID and cannot prove profile contents/isolation.

**Independent oracle:** Hidden profile list, literal disabled built-in tool/skill settings and empty item collections.

**Stable seam:** Real SessionProfileService/Store ensure/list and production native profile resolution. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/linking/indexer-profile.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| is ensured idempotently, hidden from users, empty, and launches Claude without built-in tools | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## knowledge/linking/mykg-config.test.ts

**Independent source:** docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md integration configuration; pinned myKG 0.4.10 config.py/AgentAdapter required keys.

**Regression/unique owner:** Vendor import errors, accidental fetching/export/LLM logging, too-large worker tasks or YAML type corruption. Installer smoke dependency is fake in normal tests; opt-in live test is not a substitute.

**Independent oracle:** Independently recorded required vendor keys and feature-disable values, worker/task size limits and parsed YAML documents.

**Stable seam:** Generated mykg_config.yaml consumed by YAML/PyYAML and actual atomic private-file write. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/linking/mykg-config.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| carries every key myKG reads without a default | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| turns preprocessing, fetching, the orphan pass, the report and every switchable export off | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| extracts one entry per call and keeps the inbox stocked for the worker chats | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| is written atomically, private, in the myKG dir | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| reads back identically through PyYAML when the host has it (myKG's own loader) | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## knowledge/linking/runner.test.ts

**Independent source:** docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md Linking runs / process privacy; myKG cli.py invocation and progress outputs.

**Regression/unique owner:** Unsafe session argument injection, daemon secret inheritance, lost session/stderr failure or cancellation, signalling unrelated/reused process or overlapping old/new children. Service owns orchestration; runner owns child protocol/process identity.

**Independent oracle:** Literal CLI flags, scrubbed environment keys, emitted session/progress/error records and child signals.

**Stable seam:** MykgRun process boundary plus safe argv/env and stale-process ownership checks. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/linking/runner.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| refuses a recorded session name that could become a flag or a path | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| builds the four invocations | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| is a minimal environment: HOME in the plugin, the venv first on PATH, nothing of the daemon's | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a first run creates and names its session, and its tasks are answered through the inbox | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| an update run reuses the session and only asks for the changed entry | DELETE | Failed real-regression/unique-protection bar: changed-entry filtering is implemented by fake-mykg.mjs. Retained runner argv test owns --session/--update bytes; linking/service.test.ts owns persisted update orchestration and edited entry outcomes. |
| a failed run reports the failed step and the stderr tail | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| an unknown session fails with myKG's message | DELETE | Failed unique-protection bar: verifies fake myKG refusal text through generic failure path already owned by retained a failed run reports the failed step and the stderr tail. CLI session validation also remains. |
| cancel stops the child and reports cancelled | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| leaves alone a pid that is not the recorded myKG child (another command, a reused pid, no process) | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| waits for the child to exit after SIGTERM | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| escalates to SIGKILL after the grace, and resolves only once the child is gone | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| answers alive when even SIGKILL does not end it within the bound | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| stops a real process through /proc (command line and start time) | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| signals only this knowledge base's myKG extract, never another appdir's on a recycled pid | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## knowledge/linking/service.test.ts

**Independent source:** docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md Linking runs, retry/pause/rebuild/metadata edit and persisted restart contracts.

**Regression/unique owner:** Lost mid-run edits, overlapping children, stale inbox work, broken debounce/retry/reset resume, failed graph rebuild publication or newer state destruction. Broker/pool/runner tests cannot prove persisted orchestration sequencing.

**Independent oracle:** Handwritten status/run/entry states, known file hashes, independent child output and persisted file data.

**Stable seam:** KnowledgeLinkingService public status/events/rebuild and persisted state with controlled child/clock ports. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/linking/service.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| a save made while start() still loads the state reports queued, and is linked once loading finishes | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| starts 20 s after the last change, never later than 2 min after the first; relabels never queue | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| two environment changes in a row resume an interrupted run once, and a stopped service starts none | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| is stopped (SIGTERM, SIGKILL after the grace) and gone before the resumed run starts its own child | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a survivor that cannot be stopped pauses the run with an error instead of starting a second child | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a re-run hands workers only the tasks its own process asks for; answered tasks stay cached | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| counts one name-normalization call per concept type of the current graph that has names to merge | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| an entry edited while its run is in flight stays pending and goes in the next run | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| an entry whose title or author is edited mid-run (its body hash unchanged) stays pending too | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| links new entries through worker chats, then re-links only an edited one with --update | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| pauses with resumesAt when every account is limited, survives a restart, and resumes the same run | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a failed run keeps the error, marks its entries failed, and a later change retries it | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| an update that died after myKG's ingest is re-run from the last good manifest: its edit and delete still land | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| an entry saved after a failed first run, whose session the retry resumes, is linked by an update, not claimed | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| turning the plugin off cancels the run and ends its chats; turning it on runs it again | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| rebuild extracts into a fresh session and switches to it only on success | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a failed rebuild waits for the error retry like any failed run (no tight loop) | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| only the run's own worker chats pass the worker gate | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| keeps the session and runs, links nothing, says why, and rewrites the file with its version and unknown fields | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| never writes over a newer file holding a field this build cannot read | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## knowledge/linking/workers.test.ts

**Independent source:** docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md Indexing on the subscription: pool concurrency, budgets, account failure/recovery.

**Regression/unique owner:** Spawning excess/unneeded chats, stranded lease after failure, runaway retry, paused pool restarting after completion or old-chat adoption lost. Runner/broker tests do not own pool-to-session coordination.

**Independent oracle:** Known leases/tasks/account outcomes, fake-clock transitions and explicit worker lifecycle events.

**Stable seam:** WorkerPool with real InboxBroker and independently controlled WorkerSessionPort. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/linking/workers.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| starts chats only for tasks no chat will take, up to the concurrency | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| answers every task, retiring each chat at its budget and starting a fresh one while tasks remain | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a usage limit cools the account down and fails over to another account | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| pauses with resumesAt when every account is limited, and resumes at the reset | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a run that ends while the pool is paused leaves no timer behind | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| says no-account when there is no Claude account at all | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a chat that fails mid-task has its lease reassigned to a new chat | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| chats that end their turn while holding a task count as failures: no endless restarts on a task nobody answers | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a chat that keeps submitting answers that do not parse is retired and its task handed on | REWRITE | The old case only exercised InboxBroker despite constructing WorkerPool/fake chats. Move to the existing inbox harness at the lowest stable seam; explicitly verify w2 receives the released task and invalid answers wrote no outbox file. Survives as “repeated invalid answers retire the chat and hand its task to another chat” in `apps/daemon/src/knowledge/linking/inbox.test.ts`. |
| gives up with an error after repeated start failures | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a fatal start error (the profile cannot be prepared) stops the pool at once | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| stop() interrupts and closes every chat | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| adopts a chat from before a restart that still works, and closes one that does not | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## knowledge/routes-data.test.ts

**Independent source:** docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md Agent tools/querying and AGENTS.md auth/privacy/body-error boundaries.

**Regression/unique owner:** Route ignores principal visibility, leaks metadata on edit, misses save→index handshake, mishandles optional nulls or quotes secret request bodies. Store/search tests bypass HTTP identity/parsing/error translation.

**Independent oracle:** Literal statuses/codes, saved entries, expected visible IDs, unchanged hidden content and public events.

**Stable seam:** Fastify knowledge data routes with real store/search and independently assigned caller visibility. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/routes-data.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| save answers results, created collections and the linking state read after the change | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| save refusals: unknown collection lists the valid names; bad shapes are KNOWLEDGE_INVALID | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| every route refuses while the plugin is off | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| collections: list with counts and profiles, create, rename, delete (relabelling entries) | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| entries: list, detail, edit and delete, scoped by the caller's session or agent principal | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| items, graph and search never show a profile chat what it cannot see | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| an edit that moves an entry out of a profile caller's view answers the edit, still scoped | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| framework refusals (bad JSON, too large, wrong media type) answer { code, message } on the knowledge routes only | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## knowledge/routes-linking.test.ts

**Independent source:** docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md worker tools/status/rebuild; AGENTS.md server-side principal checks.

**Regression/unique owner:** Spoofable worker identity, old-run workers accepted, rebuild gate bypassed, malformed worker answers reaching broker or broken status transport. Service tests own registration/lifecycle, not all route validation branches.

**Independent oracle:** Literal HTTP codes, stamped principal IDs, input-size results and declared status/event fields.

**Stable seam:** Fastify linking/worker routes and status publisher. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/routes-linking.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| status is the linking snapshot plus the injected counts | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| rebuild is refused while the plugin is off or not installed, else starts and answers the status | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a refusal from the linking module keeps its code and message; an unexpected failure is 500 KNOWLEDGE_ERROR | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| worker routes refuse any session that is not a worker chat of the run in flight | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| the calling chat is the agent principal's, never a session id the body claims | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| submit checks its body before the broker sees it | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| publishes the whole status on every linking change | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## knowledge/search/embedder.model.test.ts

**Independent source:** docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md local semantic search/embedding cache.

**Regression/unique owner:** Tokenizer/pooling/model mismatch, wrong shape or stale model after runtime change. Fake embedder search tests cannot prove real semantic model interoperability. Model-gated test retained; runtime not claimed available.

**Independent oracle:** Known 384-dimensional normalized vectors, semantic ordering of independent phrases and observed lazy runtime swaps.

**Stable seam:** Real OnnxSentenceEmbedder and runtimeEmbedderSource with installed model files. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/embedder.model.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| all-MiniLM-L6-v2 on onnxruntime-node: 384-d normalized vectors, semantically ordered, fast when warm | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| the runtime source makes the embedder lazily and swaps it when the runtime changes | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## knowledge/search/graph.test.ts

**Independent source:** docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md visible graph/querying and myKG JSONL output format.

**Regression/unique owner:** Hidden provenance leaks, incorrect traversal/degree/truncation, malformed JSONL destroying graph or older load overwriting new graph. Search routes do not isolate all graph provenance/reload contracts.

**Independent oracle:** Independent graph fixtures with explicit provenance, literal visible subgraphs and controlled overlapping FIFO load.

**Stable seam:** KnowledgeGraph JSONL load and public graph/concept/path/related/search views. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/graph.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| the whole graph for a profile holds only visible concepts and edges, counted on the visible subgraph | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a path through a hidden concept is not a path | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| focus on an entry starts from its concepts; depth bounds the hops | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| concept detail, entries, related entries and concept search are all visibility-scoped | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| deleted entries stop making concepts visible before the graph is rebuilt | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| truncation keeps the most connected nodes and says so | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| load reads myKG's jsonl from a session output dir, tolerating bad lines and null attributes | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| an edge whose source_files list is empty has no visible support | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| overlapping loads: the graph ends up as the one loaded last, never an older one | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| conceptTypes counts the concepts of each type in the whole graph | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## knowledge/search/search.perf.test.ts

**Independent source:** docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md Fast: about 300ms p95 at 5,000 entries.

**Regression/unique owner:** Search performance collapses at documented representative scale. Small functional tests cannot own scale/latency; retained intentional cost, no claim of real ONNX latency from this fake embedder benchmark.

**Independent oracle:** Measured query durations against documented 300ms threshold and nonempty result assertions.

**Stable seam:** Real KnowledgeSearch index/ranking/graph code over 5,000 independent entries and 384-dimensional embedder port. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/search.perf.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| hybrid search over 5,000 entries: p95 under 300 ms | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## knowledge/search/search.test.ts

**Independent source:** docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md Querying, Collections and profiles, Fast/save availability.

**Regression/unique owner:** Missing semantic/text results, hidden expansion, stale/cross-model vectors, inaccessible new entries, broken pagination or chat-blocking model startup. Graph/cache tests own primitives, not index/fusion/liveness coordination.

**Independent oracle:** Known visible entry/concept IDs, supplied document text and explicit pending-model gates/clock.

**Stable seam:** KnowledgeSearch public query/index/list/detail/item/graph methods with independent store/embedding ports. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/search.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| search by meaning finds an entry that shares no words with the query | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| BM25 finds words in titles, bodies and concepts; concept hits carry visible entry ids | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a profile never gets hidden entries or concepts, even through the one-hop expansion | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| the collections filter narrows within visibility; unknown or hidden names are refused with what is visible | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a new, unlinked entry is searchable by text and meaning as soon as it is indexed | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| without a runtime, or when the model fails, search degrades to text and never fails | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| vectors are cached by content hash and reused across restarts; another model rebuilds | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| read views: entry lists page newest first; details and items respect visibility | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| vectors are cached under the hash of the text that was embedded, not the hash the store claims | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a save waits a bounded time for its embeddings (a slow first model load never holds the chat) | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## knowledge/search/vector-cache.test.ts

**Independent source:** docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md disposable contentHash embedding cache and atomic persistence constraints.

**Regression/unique owner:** Reusing vectors from wrong model, trusting partial/uncommitted binary writes or losing live rows during compaction. Search-level warm restart does not simulate torn manifests/binaries.

**Independent oracle:** Hand-supplied float rows, reopened hashes and actual file lengths after simulated interrupted writes.

**Stable seam:** VectorCache open/put/flush/retain over real binary/manifest files. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/vector-cache.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| rows survive a reopen; an interrupted append past the manifest is cut off | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| rows put but not flushed are dropped on reopen (the manifest is the truth) | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| another model, a corrupt manifest or a short file discards the cache | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| retain forgets dead hashes and compacts into a new generation | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## knowledge/service.test.ts

**Independent source:** docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md plugin switch/readiness, manifest/profile integration; AGENTS.md remote boundaries.

**Regression/unique owner:** Opening work while disabled, failing recovery after unreadable store, missing graph/entry/profile broadcasts or exposing local worker routes remotely. Data/linking route tests instantiate routes directly and cannot own service composition.

**Independent oracle:** Real route/status outcomes, directory existence, independently controlled linking/runtime/profile events.

**Stable seam:** KnowledgeService lifecycle/registerRoutes/public manifest/status methods and events. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/service.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| with the plugin off nothing opens: no store directory, no embedder, no linking; data routes 409, settings and status answer | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| the first switch-on opens the knowledge base and builds and starts linking on its store and graph; switching off releases the embedder; on again serves without reopening | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| before start a request is told the plugin is starting; start opens it | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a knowledge base that cannot open: routes answer 500 KNOWLEDGE_ERROR, the status names it, and the next request retries | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a linking module that cannot be built, or cannot start, leaves linking paused with the error; the data routes still serve | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| worker routes: the worker is the stamped principal only, and must be a worker chat of the run in flight | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| the worker routes are the unix-socket app's only: the remote app serves the rest without them | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a profile ticking or unticking a collection (or renamed while it ticks one) refreshes the collection views; an unrelated edit does not | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## knowledge/settings.test.ts

**Independent source:** docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md indexing account/model/concurrency settings and legacy accountId compatibility; AGENTS.md tolerant stores.

**Regression/unique owner:** Wrong downgrade-compatible account selection, invalid/wrong-family settings written, no-op broadcasts, unreadable record overwritten or malformed HTTP errors leaking body. Config parsers alone do not drive service merge/write/HTTP behavior.

**Independent oracle:** Literal legacy policy order, supplied current/older records, refused codes and preserved on-disk unknown keys.

**Stable seam:** KnowledgeSettingsService plus real PluginsService and settings HTTP routes. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/settings.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| defaults until set; a stored value of the wrong type or out of range reads as its default | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a legacy accountId reads as the policy it meant | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a stored policy is read field by field, and wins unless an older build changed accountId after it | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| an update is validated, merged into the record and kept beside keys another build wrote | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a policy update is stored with the accountId an older build would run; a legacy accountId update drops it | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| refusals: concurrency out of bounds, a bad policy, a non-Claude account, an unknown legacy accountId, an empty model, a non-object | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| the port: enabled follows the plugin, and onChange fires on a toggle or a settings change only | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| GET and PUT the settings route; refusals are { code, message } | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| an unreadable plugins.json is reported and never written over | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| settings route: bad JSON, an oversized body and a wrong media type answer { code, message } | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## knowledge/store/store.test.ts

**Independent source:** docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md Saving/dedup/collections/on-disk layout and AGENTS.md tolerant atomic persistence.

**Regression/unique owner:** Lost entry data, bad dedup/collection union, non-atomic partial save, stale/missing mirror, newer data destruction or relabel triggering extraction. Routes drive transport; this is the lowest filesystem/dedup/recovery owner.

**Independent oracle:** Independent bodies/metadata/URLs, literal dedup IDs and unknown fields, observed original file bytes and change events.

**Stable seam:** KnowledgeStore save/update/delete/open over real entry/frontmatter/mirror/collections files. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/store/store.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| save writes the entry, the frontmatter round-trips, and the mirror carries the header | REWRITE | Preserve file/frontmatter/citation/reopen and metadata/body/collection-exclusion assertions; delete the hash assertion that recomputed its expected value through the production hash function; dedup/edit cases retain meaningful hash behavior; replace cosmetic Markdown separator/header snapshot by independent supplied field contents. Distinct title prevents body from satisfying title oracle. |
| mirror header omits missing parts cleanly | REWRITE | Keep unique handle-without-author data preservation via actual mirror; delete redundant empty-metadata save and cosmetic note/header whitespace snapshots. Main save owns full body/metadata roundtrip. Survives as “the mirror keeps a handle when the author and other metadata are absent”. |
| unknown collections are refused with the valid names, and nothing is written | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| limits use the contract's codes | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| dedup: same URL, same normalized text, near-identical text; new collections are unioned in | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| url normalization | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| edits: text edits are `edited` and rewrite the mirror; collection-only edits are `relabelled` and leave it alone | REWRITE | Compare the post-edit content hash to the previously observed stored hash, not to a production hash function called again by the test. Preserve edited/relabelled event distinctions and all file/link-state checks. |
| deleting a collection relabels its entries; deleting an entry removes its mirror | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| startup: malformed entries are skipped and kept; unknown fields survive; the mirror is reconciled | REWRITE | Preserve malformed/unknown-field/orphan/temp/missing-mirror recovery; assert repaired stale mirror contains its original body, whose distinct stored title prevents false positive. Drop cosmetic Markdown framing. |
| a corrupt collections.json is moved aside, not overwritten | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| collection colours go round-robin and writes are serialized | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a save is all or nothing even when relabelling a duplicate fails after the new entries were written | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| bodies without a single word are only duplicates when identical | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a collections.json from a newer version is left in place and never written over | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| a collection colour this build does not know shows as a palette colour and stays on disk through rewrites | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| savedFrom: unknown keys and an unknown `by` are read tolerantly and written back as found | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |

## knowledge/visibility.test.ts

**Independent source:** docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md Collections and profiles/fail closed/worker privacy.

**Regression/unique owner:** Unknown/unreadable/deleted sessions seeing all knowledge, stale profile edits or worker visibility leak. Graph/search tests consume already-computed scopes and cannot own scope derivation.

**Independent oracle:** Independent Global/profile/deleted/worker identities and literal visible collection sets.

**Stable seam:** KnowledgeSessionVisibility.forSession/isWorker and manifest view constructor over session/profile ports. **Refactor resistance:** Assertions observe the named public data/protocol/state/error result, without depending on private collaborator identities or cosmetic layout. Rewritten cases remove the exceptions described in their disposition.

**Validation:** `From apps/daemon: TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/visibility.test.ts`.

| Baseline test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| forSession: no session and Global chats see all; a profile chat its ticked ids; a worker, an unknown session and an unreadable profile nothing | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| forSession is fresh: a profile edit or a profile switch shows on the next call | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| isWorker and ownerKindOf read the owner's kind whatever the owner union holds | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
| createKnowledgeForSession: off, Global, a profile with and without collections, deleted ids dropped, a worker | KEEP | Keep the exact named contract at the seam above; unique failure and independent oracle are the corresponding case of the file evidence. |
