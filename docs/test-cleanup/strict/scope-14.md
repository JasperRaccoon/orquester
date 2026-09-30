# Scope 14: strict host runtime test cleanup

Status: completed cleanup, not audit-only. All pre-edit dispositions are recorded below; changed-file and full-scope validation passed. Reviewed 26 files: 10 DELETE, 12 REWRITE, 294 KEEP. Test source is net 130 lines smaller. Baseline has 318 extracted entries: 316 test declarations plus two RegExp.test false positives named `value` at fixture-redaction.test.ts:176. Parameterized declarations are listed once with their explicit input/expected table described below.

This ledger was written before changing any scope-14 test or production owner. Read AGENTS.md, root/daemon package scripts, host module map, fixture provenance/redaction sections, current production owners and relevant GUI design contracts. No live daemon is operated.

The six-bar justification applies per file together with each case’s oracle below: **B1** the cited requirement/protocol/security rule is independent of the implementation; **B2** reversing the named state/data/byte outcome causes the listed transcript, caller or isolation failure; **B3** the original assertions below use authored inputs, literal outcomes or recorded provider frames, with identified exceptions rewritten; **B4** the stated stable service/byte/filesystem seam is exercised; **B5** surviving assertions do not inspect private call topology, identifiers or DOM geometry; **B6** the file’s distinct ownership is stated, and known duplicate owners are explicitly removed. A public serialized event identity is a storage protocol value, not a private variable name.

Risk: medium overall (authentication, process isolation, durable logs); deletions are limited to declarations, appearance and demonstrated duplicates. Rewrites preserve the real contract while removing private exports, a vacuous negative and an implementation-derived threshold. Runtime algorithms and behavior are unchanged.

Focused command for each file: `node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test --test-concurrency=2 <path>`. Whole scope uses the same command with `$(cat /tmp/orquester-test-audit/scope-14.txt)`; repository gates belong to root.

## `apps/daemon/src/agent-host/adapters/attachment-lines.test.ts`

Independent source (B1): GUI design §§4.1, 4.5, 4.6.8–9, 6.2 and 7.4: attachment paths reach provider prompts without changing command position or forging lines; native history retains user text. The malformed suffix case protects against exponential regex work on provider text.

Stable seam and refactor tolerance (B4–B5): appendAttachmentPathLines/attachedFileLine/stripAttachmentPathLines/isAttachmentPathBlock: text-in/text-out protocol seam. No test-only implementation branch is required.

Non-test callers: All four provider send paths; Claude/Codex/Grok history projection; orchestration question answers.

Lowest distinct owner / remaining stronger coverage (B6): Each case covers a distinct grammar/sanitization/negative-boundary input; adapter tests own dispatch, not this cross-provider grammar.

Cases below name their recognizable failure; “oracle” records the original concrete expected output/state checks (B2–B3), inspected before editing. For REWRITE, the disposition explains which assertion/seam changes; the external contract remains the same.

- **KEEP** ``appends an `Attached files:` block as a suffix, one `- name: path` line per attachment`` (baseline line 12). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal( appendAttachmentPathLines("look at these", [ { name: "q3.xlsx", path: "/a/t1-1-xlsx.xlsx" }, { name: "notes.txt", path: "/a/t1-2-txt.txt" } ]), "look at these\n\nAttached files:\n- q3.xlsx: /a/t1-1-xlsx.xlsx\n- notes.txt: /a/t1-2-txt.txt" )``

- **KEEP** ``is the block alone when the text is empty, so an attachment-only turn still says something`` (baseline line 22). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal( appendAttachmentPathLines("", [{ name: "q3.xlsx", path: "/a/x.xlsx" }]), "Attached files:\n- q3.xlsx: /a/x.xlsx" )``

- **KEEP** ``skips a path the text already names — the composer put it there (§7.4) — and returns the text by identity when nothing is left`` (baseline line 29). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(appendAttachmentPathLines(text, [{ name: "x.xlsx", path: "/a/x.xlsx" }]), text)``; ``assert.equal( appendAttachmentPathLines(text, [ { name: "x.xlsx", path: "/a/x.xlsx" }, { name: "y.csv", path: "/a/y.csv" } ]), "see /a/x.xlsx please\n\nAttached files:\n- y.csv: /a/y.csv" )``; ``assert.equal(appendAttachmentPathLines(text, []), text)``

- **KEEP** ``collapses a run of control characters in a name to one space, so a name cannot forge a line of the turn`` (baseline line 42). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal( appendAttachmentPathLines("", [{ name: "bad\nname.txt", path: "/a/b.txt" }]), "Attached files:\n- bad name.txt: /a/b.txt" )``; ``assert.equal( appendAttachmentPathLines("", [{ name: "a\r\n\u007fb.txt", path: "/a/c.txt" }]), "Attached files:\n- a b.txt: /a/c.txt" )``

- **KEEP** ``flattens C1 controls and Unicode line separators too, trims, caps a name at 255 and never leaves it empty`` (baseline line 53). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal( appendAttachmentPathLines("", [{ name: " a\u0085b\u2028c\u2029d.txt ", path: "/a/d.txt" }]), "Attached files:\n- a b c d.txt: /a/d.txt" )``; ``assert.equal( appendAttachmentPathLines("", [{ name: long, path: "/a/l.txt" }]), `Attached files:\n- ${"x".repeat(255)}: /a/l.txt` )``; ``assert.equal(Array.from(attachedFileLine(emoji, "/p").slice("Attached file: ".length)).length, 255 + " (/p)".length)``; ``assert.equal( appendAttachmentPathLines("", [{ name: "\u0000\n\t", path: "/a/e" }]), "Attached files:\n- attachment: /a/e" )``

- **KEEP** ``names an answer's file on one line, with its path or as not available (§6.2)`` (baseline line 72). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(attachedFileLine("notes.md", "/a/notes.md"), "Attached file: notes.md (/a/notes.md)")``; ``assert.equal(attachedFileLine("a\u0085b\u2028c", undefined), "Attached file: a b c (not available)")``

- **KEEP** ``reads `namedIn` for a path already named, and still appends to `text` (§4.6.8)`` (baseline line 77). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(appendAttachmentPathLines("please", lines, "please $review /a/x.xlsx"), "please")``; ``assert.equal( appendAttachmentPathLines("please", lines, "please $review"), "please\n\nAttached files:\n- x.xlsx: /a/x.xlsx" )``

- **KEEP** ``removes a literal persisted trailing attachment block`` (baseline line 90). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal( stripAttachmentPathLines("look at these\n\nAttached files:\n- q3.xlsx: /a/q3.xlsx\n- b c.txt: /a/b c.txt"), "look at these" )``

- **KEEP** ``keeps a block that is the whole message: a replay has no attachment chips to show instead`` (baseline line 97). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(stripAttachmentPathLines(alone), alone)``; ``assert.equal(stripAttachmentPathLines(blank), blank)``

- **KEEP** ``returns text without a trailing block by identity, including a mid-text mention`` (baseline line 105). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(stripAttachmentPathLines(plain), plain)``; ``assert.equal(stripAttachmentPathLines(mid), mid)``; ``assert.equal(stripAttachmentPathLines(""), "")``

- **KEEP** ``answers in linear time when a block-shaped run fails at its last line`` (baseline line 113). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(stripAttachmentPathLines(text), text)``; ``assert.ok( elapsed < baseline * 25, `expected <${(baseline * 25).toFixed(1)}ms (25x the ${baseline.toFixed(1)}ms linear baseline), took ${elapsed.toFixed(1)}ms` )``; ``assert.equal(stripAttachmentPathLines(pathological.slice(0, -"\nand then more".length)), "hi")``

- **KEEP** ``recognises persisted attachment-only blocks`` (baseline line 151). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(isAttachmentPathBlock("Attached files:\n- q3.xlsx: /a/q3.xlsx"), true)``; ``assert.equal( isAttachmentPathBlock( "Attached files:\n- q3.xlsx: /a/q3.xlsx\n- b c.txt: /a/b c.txt" ), true )``; ``assert.equal(isAttachmentPathBlock("Attached files:\n- a: b: c"), true)``

- **KEEP** ``is false for anything around the block — leading blank lines, trailing prose — and for empty text`` (baseline line 163). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(isAttachmentPathBlock("\n\nAttached files:\n- q3.xlsx: /a/q3.xlsx"), false)``; ``assert.equal(isAttachmentPathBlock("Attached files:\n- q3.xlsx: /a/q3.xlsx\n\nand more"), false)``; ``assert.equal(isAttachmentPathBlock("hi\n\nAttached files:\n- q3.xlsx: /a/q3.xlsx"), false)``; ``assert.equal(isAttachmentPathBlock("Attached files:\n- q3.xlsx: /a/q3.xlsx\n"), false)``; ``assert.equal(isAttachmentPathBlock("Attached files:"), false)``; ``assert.equal(isAttachmentPathBlock(""), false)``



## `apps/daemon/src/agent-host/adapters/auth-status.test.ts`

Independent source (B1): GUI design §7.7 and the reported false sign-in warning regression: silence is unknown; only positive credentials authenticate and only explicit login requirements prove unauthenticated.

Stable seam and refactor tolerance (B4–B5): Provider snapshot builders and Codex read-only probe, after rewrite. No test-only implementation branch is required.

Non-test callers: Claude snapshot assembly, Codex adapter refresh, OpenCode snapshot refresh.

Lowest distinct owner / remaining stronger coverage (B6): Failure/absence, Bedrock metadata, email-only, subscription-only, required-login and account-type cases distinguish credential evidence; OpenCode populated success is deleted in favor of real adapter coverage.

Cases below name their recognizable failure; “oracle” records the original concrete expected output/state checks (B2–B3), inspected before editing. For REWRITE, the disposition explains which assertion/seam changes; the external contract remains the same.

- **REWRITE** ``is `unknown` when the probe itself failed`` (baseline line 28). Observe authentication through public buildClaudeSnapshot/probeCodex/buildSnapshot outputs, preserving the input credential evidence and literal auth verdict. Remove exported private auth helpers; transport stubs supply raw RPC answers only and never compute auth.

  Oracle: ``assert.equal(buildClaudeAuth(undefined).status, "unknown")``

- **REWRITE** ``is `unknown` — never `unauthenticated` — when the init carried no account`` (baseline line 32). Observe authentication through public buildClaudeSnapshot/probeCodex/buildSnapshot outputs, preserving the input credential evidence and literal auth verdict. Remove exported private auth helpers; transport stubs supply raw RPC answers only and never compute auth.

  Oracle: ``assert.equal( auth.status, "unknown", "claude initialises fine under API-key/Bedrock envs and under logins whose account block it does not return" )``

- **REWRITE** ``keeps the api provider on the ambiguous verdict, for the card to label`` (baseline line 41). Observe authentication through public buildClaudeSnapshot/probeCodex/buildSnapshot outputs, preserving the input credential evidence and literal auth verdict. Remove exported private auth helpers; transport stubs supply raw RPC answers only and never compute auth.

  Oracle: ``assert.equal(auth.status, "unknown")``; ``assert.equal(auth.type, "bedrock")``

- **REWRITE** ``is `authenticated` only once the init POSITIVELY yields credentials`` (baseline line 47). Observe authentication through public buildClaudeSnapshot/probeCodex/buildSnapshot outputs, preserving the input credential evidence and literal auth verdict. Remove exported private auth helpers; transport stubs supply raw RPC answers only and never compute auth.

  Oracle: ``assert.equal(byEmail.status, "authenticated")``; ``assert.equal(byEmail.email, "a@b.c")``; ``assert.equal(byPlan.status, "authenticated")``; ``assert.equal(byPlan.label, "max")``

- **REWRITE** ``is `unknown` when `account/read` could not be read at all`` (baseline line 59). Observe authentication through public buildClaudeSnapshot/probeCodex/buildSnapshot outputs, preserving the input credential evidence and literal auth verdict. Remove exported private auth helpers; transport stubs supply raw RPC answers only and never compute auth.

  Oracle: ``assert.equal(codexAuth(undefined).status, "unknown")``

- **REWRITE** ``is `unauthenticated` ONLY when the CLI says an OpenAI login is required`` (baseline line 63). Observe authentication through public buildClaudeSnapshot/probeCodex/buildSnapshot outputs, preserving the input credential evidence and literal auth verdict. Remove exported private auth helpers; transport stubs supply raw RPC answers only and never compute auth.

  Oracle: ``assert.equal( codexAuth({ account: null, requiresOpenaiAuth: true } as never).status, "unauthenticated" )``; ``assert.equal( codexAuth({ account: null, requiresOpenaiAuth: false } as never).status, "unknown", "no account and no requirement is not a logged-out verdict" )``

- **REWRITE** ``is `authenticated` for every account shape it recognises`` (baseline line 75). Observe authentication through public buildClaudeSnapshot/probeCodex/buildSnapshot outputs, preserving the input credential evidence and literal auth verdict. Remove exported private auth helpers; transport stubs supply raw RPC answers only and never compute auth.

  Oracle: ``assert.equal( codexAuth({ account: { type: "chatgpt", planType: "pro", email: "a@b.c" }, requiresOpenaiAuth: false } as never).status, "authenticated" )``; ``assert.equal( codexAuth({ account: { type: "apiKey" }, requiresOpenaiAuth: false } as never).status, "authenticated" )``

- **REWRITE** ``is `unknown` with nothing connected — there is no `opencode auth list` to ask`` (baseline line 94). Observe authentication through public buildClaudeSnapshot/probeCodex/buildSnapshot outputs, preserving the input credential evidence and literal auth verdict. Remove exported private auth helpers; transport stubs supply raw RPC answers only and never compute auth.

  Oracle: ``assert.equal(openCodeAuth(inventory([])).status, "unknown")``

- **DELETE** ``is `authenticated` as soon as one upstream is connected`` (baseline line 98). Duplicates the real OpenCode adapter snapshot-budget.test.ts cold and cwd-less refresh authentication assertions (confirmed with OpenCode agent). Keep the distinct empty-connected ambiguity via buildSnapshot.



## `apps/daemon/src/agent-host/adapters/fixture-redaction.test.ts`

Independent source (B1): AGENTS.md secret-redaction rule plus all four fixture READMEs Redaction sections: host paths/account UUIDs/credentials must be absent, including across stream pieces and decoded byte arrays. Claude streamed and complete values must agree.

Stable seam and refactor tolerance (B4–B5): Committed protocol capture bytes and provider wire frames; no production implementation participates. No test-only implementation branch is required.

Non-test callers: Capture files are consumed by provider replay tests and document protocol evidence; the scan itself has no runtime callers.

Lowest distinct owner / remaining stronger coverage (B6): This is the single fixture privacy post-check. The fixture-directory coverage assertion guards an omitted sensitive path, not a source/export inventory; renaming production identifiers cannot change it.

Cases below name their recognizable failure; “oracle” records the original concrete expected output/state checks (B2–B3), inspected before editing. For REWRITE, the disposition explains which assertion/seam changes; the external contract remains the same.

- Inventory correction: `value` is a call to a RegExp `.test(value)`, not a test declaration. No disposition or code deletion applies.

- Inventory correction: `value` is a call to a RegExp `.test(value)`, not a test declaration. No disposition or code deletion applies.

- **KEEP** ``covers every fixture set`` (baseline line 513). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(sets, [...FIXTURE_SETS])``

- **KEEP** ```${set}: no line, decoded byte array or joined stream holds a host-identifying value``` (baseline line 522). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(findings.length, 0, listFindings(set, findings))``

- **KEEP** ``claude: every streamed block joins to what its complete frame holds`` (baseline line 528). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(mismatches, [], `a streamed block its complete frame disagrees with:\n${mismatches.join("\n")}`)``



## `apps/daemon/src/agent-host/adapters/pending.test.ts`

Independent source (B1): GUI design §3.2 pending provider seeds and §7.7 ambiguity: providers exist before probes without asserting a false authentication verdict; uninstalled probe results remain cacheable.

Stable seam and refactor tolerance (B4–B5): Pending snapshot API and production isPendingSnapshot classifier. No test-only implementation branch is required.

Non-test callers: Static adapter registry -> provider-snapshots registry/cache.

Lowest distinct owner / remaining stronger coverage (B6): Keep identity/unknown-state/cache discrimination; remove tests asserting static catalogue contents/counts without a launch.

Cases below name their recognizable failure; “oracle” records the original concrete expected output/state checks (B2–B3), inspected before editing. For REWRITE, the disposition explains which assertion/seam changes; the external contract remains the same.

- **KEEP** ``is synchronous and self-describing`` (baseline line 27). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(snapshot.id, id)``; ``assert.ok(snapshot.refIds.includes(id), "its own registry id is served")``; ``assert.equal(snapshot.checkedAt, CHECKED_AT, "the caller's clock, no I/O of its own")``; ``assert.equal(snapshot.installed, false)``; ``assert.equal(snapshot.version, null)``

- **KEEP** ``claims no verdict: status unknown, auth unknown, the T3 message`` (baseline line 35). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(snapshot.status, "unknown")``; ``assert.equal(snapshot.auth.status, "unknown")``; ``assert.match(snapshot.message ?? "", /has not been checked in this session yet\.$/)``; ``assert.ok(isPendingSnapshot(snapshot))``

- **DELETE** ``Claude and Grok ship a bundled catalogue, so their launchers work on a cold host`` (baseline line 45). Static catalogue nonemptiness; it never attempts a launch and cannot prove cold-host launchability. Remaining owner: provider-snapshots.test.ts layer-1 registry seed scenario and provider adapter launch tests. No production seam removed.

- **DELETE** ``Claude's pending catalogue names a default`` (baseline line 52). Static model declaration check; does not exercise default model selection or a launch. Remaining owner: adapter launch/snapshot behavior; a catalogue refactor need not preserve this count.

- **DELETE** ``every pending catalogue is free of duplicate slugs`` (baseline line 58). Declaration inventory without a demonstrated caller failure. Catalogue/launch consumers retain behavioral tests; no test-only helper is needed.

- **KEEP** ``isPendingSnapshot rejects a real probe result`` (baseline line 65). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal( isPendingSnapshot({ status: "ready", auth: { status: "authenticated" }, installed: true }), false )``; ``assert.equal( isPendingSnapshot({ status: "error", auth: { status: "unknown" }, installed: false }), false )``; ``assert.equal( isPendingSnapshot({ status: "unknown", auth: { status: "unknown" }, installed: false, message: "OpenCode is not installed. Orquester requires v0.15.0 or newer." }), false )``; ``assert.equal( isPendingSnapshot({ status: "unknown", auth: { status: "unknown" }, installed: false }), false, "no message at all is not a pending seed either" )``



## `apps/daemon/src/agent-host/host-teardown.test.ts`

Independent source (B1): AGENTS.md runtime ownership, GUI design §§3.1 and 3.3: stop drains final log facts, kills owned helpers, preserves user work on deploy, kills it on user end, and continues marked turns after intentional handover.

Stable seam and refactor tolerance (B4–B5): Real isolated startAgentHost/stop and authenticated HTTP stop; real children and on-disk logs. No test-only implementation branch is required.

Non-test callers: Daemon host supervisor, host signal handler, session stop, next-host reconciliation.

Lowest distinct owner / remaining stronger coverage (B6): Only composition-root tests catch abort-triggered stopAll racing explicit stopAll and consumer shutdown. Adapter unit tests do not run this race. These are process integrations, not browser E2E; logs/process identities are verified before temp teardown.

Cases below name their recognizable failure; “oracle” records the original concrete expected output/state checks (B2–B3), inspected before editing. For REWRITE, the disposition explains which assertion/seam changes; the external contract remains the same.

- **KEEP** ``a host teardown waits for every Grok session's stop: its helpers swept, the left-running row and the stop in the log, its work left running`` (baseline line 260). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(before.helper.length, 1, "the helper runs")``; ``assert.equal(before.shell.length, 1, "and so does the shell the turn left")``; ``assert.deepEqual(after.helper, [], "the session's helper is swept before the teardown resolves")``; ``assert.deepEqual(after.shell, before.shell, "a deploy never kills running work")``; ``assert.deepEqual(after.member, before.member)``; ``assert.deepEqual(after.daemon, before.daemon, "nor what daemonized away")``; ``assert.deepEqual( activitiesOf(log, "task.completed") .filter((activity) => (activity.payload as { taskId?: string }).taskId === "task-bg-1") .map((activity) => { const payload = activity.payload as { status?: string; summary?: string; leftRunning?: boolean }; return [payload.status, payload.leftRunning]; }), [["stopped", true]], "the shell's closing row reaches the log, saying where to stop it" )``; ``assert.equal(sessionSets(log).at(-1)?.payload.session.status, "stopped", "and so does the session's own stop")``; ``assert.equal(remembered.launches.length, 1, "the work it left running is remembered for the user's end")``

- **KEEP** ``an authenticated host stop reaps a helper that ignores SIGTERM before reporting completion`` (baseline line 307). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(launched(mark).helper.length, 1, "the helper runs")``; ``assert.deepEqual(launched(mark).helper, [], "only the SIGKILL ends it, and it came")``

- **KEEP** ``a host teardown waits for every Codex session's stop: the turn's settle, a live agent's stop and the session's in the log, the child gone`` (baseline line 330). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(child().length, 1, "the session's app-server runs")``; ``assert.deepEqual(child(), [], "the app-server is gone before the teardown resolves")``; ``assert.equal(sets.at(-1)?.payload.session.status, "stopped", "the session's stop reaches the log")``; ``assert.ok( sets.some((event) => event.payload.turn?.turnId === "thread-mock-1-turn-1"), "so does the running turn's settle" )``; ``assert.deepEqual( activitiesOf(log, "task.completed").map((activity) => { const payload = activity.payload as { taskId?: string; status?: string }; return [payload.taskId, payload.status]; }), [["child-1", "stopped"]], "and the live agent's stop" )``

- **KEEP** ``the user's end of a Grok session is prepared before its card is answered: a CLI that exits on the cancel still has its work stopped, and its row says so`` (baseline line 397). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(before.shell.length, 1, "the shell runs")``; ``assert.equal(before.member.length, 1)``; ``assert.equal(before.daemon.length, 1)``; ``assert.deepEqual(after.helper, [])``; ``assert.deepEqual(after.shell, [], "the user ended the session: its work goes with it")``; ``assert.deepEqual(after.member, [])``; ``assert.deepEqual(after.daemon, before.daemon, "never what daemonized away")``; ``assert.deepEqual( activitiesOf(log, "task.completed") .filter((activity) => (activity.payload as { taskId?: string }).taskId === "task-bg-1") .map((activity) => { const payload = activity.payload as { status?: string; summary?: string; leftRunning?: boolean }; return [payload.status, payload.leftRunning]; }), [["stopped", undefined]], "it really stopped: nothing left running to speak of" )``; ``assert.equal( existsSync(agentChatThreadLeftoverWorkPath(rig.appdir, "t1")), false, "and the thread remembers none of it" )``

- **KEEP** ``an intentional stop's running Grok turn is continued by the next host, the teardown's rows kept`` (baseline line 605). **B1:** GUI design §3.3 requires an opted-in running turn to resume after an intentional host stop, retaining the teardown settlement and clearing its continuation marker. **B2:** losing or duplicating the turn, preserving a stale marker, or falsely reporting a restart error fails the disk/log observations. **B3:** the expected stopped/cleared states, exactly one settlement, and no runtime error are literal requirements; they are not produced by the mocked CLI. **B4–B5:** two real hosts use one temporary appdir and the authenticated stop route; observations are persisted metadata and domain events, independent of private call ordering. **B6:** only this composition test combines Grok cancellation, host teardown event draining, persisted marker retention, and next-host continuation; adapter and reconciliation unit tests do not exercise that boundary.

  Oracle: `handover` asserts HTTP 200 with `{ ok: true, markedThreadIds: ["t1"] }`, then persisted metadata has `session.status === "stopped"`, `activeTurnId === null`, a stamped continuation marker for the original running turn, and a second host's log eventually records a different running turn (otherwise `untilLog` rejects after its deadline). `assertContinued` requires the persisted marker to be absent, exactly one log settlement for the original turn, and an empty `runtime.error` activity list. These helper assertions execute in this named case; the original direct-assert extraction omitted them.

- **KEEP** ``an intentional stop's running Codex turn is continued by the next host, the teardown's rows kept`` (baseline line 618). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: the same `handover` and `assertContinued` assertions documented for the Grok case execute here: authenticated stop acknowledgment, stopped metadata with a stamped marker for the original turn, a different running turn on the second host, cleared marker, exactly one old-turn settlement, and no restart error. In addition, ``assert.equal(resumed.length, 1, "the next host resumed the thread from its cursor")`` checks the recorded Codex `thread/resume` wire request. The public provider protocol and disk/log artifacts distinguish Codex's promptless continuation from Grok's ordinary continuation; neither adapter's successful handover proves the other's, satisfying B6. The same independently specified §3.3 state outcomes and real two-host seam establish B1–B5; the provider mock never computes those persistence or reconciliation results.



## `apps/daemon/src/agent-host/ingestion/activities.test.ts`

Independent source (B1): GUI design §§4.2, 5.1, 5.6, 7.6 and agent-goals design §4.3: normalize runtime facts into persisted approval/tool/task/context/goal data. Workflow design §5.4 requires account failure reason/reset metadata.

Stable seam and refactor tolerance (B4–B5): runtimeEventToActivities, the stateless runtime-event -> durable activity protocol boundary. No test-only implementation branch is required.

Non-test callers: Stateful ingestion live/history paths; orchestration leftover-work uses shared linkage projection.

Lowest distinct owner / remaining stronger coverage (B6): These cases own each distinct mapping/omission/linkage/boundary; adapter tests stop at RuntimeEvent and API folds begin at DomainEvent. Tone-only and duplicate internal omission checks are removed.

Cases below name their recognizable failure; “oracle” records the original concrete expected output/state checks (B2–B3), inspected before editing. For REWRITE, the disposition explains which assertion/seam changes; the external contract remains the same.

- **KEEP** ```${requestType} -> ${expected ?? "unmapped"}``` (baseline line 40). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.ok(row)``; ``assert.equal(payloadOf(row).requestKind, expected)``

- **KEEP** ``request.opened keeps BOTH the canonical kind and the raw requestType`` (baseline line 49). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(rest.length, 0)``; ``assert.ok(row)``; ``assert.equal(row.activityKind, "approval.requested")``; ``assert.equal(row.tone, "approval")``; ``assert.equal(row.turnId, "turn-1")``; ``assert.equal(payload.requestKind, "command")``; ``assert.equal(payload.requestType, "exec_command_approval")``; ``assert.equal(payload.requestId, "req-1")``; ``assert.equal(payload.dismissible, false)``

- **KEEP** ``tool_user_input is dropped from BOTH request arms — it is a question, not an approval`` (baseline line 70). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual( runtimeEventToActivities( runtimeEvent("request.opened", { requestType: "tool_user_input", dismissible: true }) ), [] )``; ``assert.deepEqual( runtimeEventToActivities( runtimeEvent("request.resolved", { requestType: "tool_user_input" }) ), [] )``

- **KEEP** ``request.resolved carries the decision`` (baseline line 85). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.ok(row)``; ``assert.equal(row.activityKind, "approval.resolved")``; ``assert.equal(payloadOf(row).requestKind, "permission")``; ``assert.equal(payloadOf(row).decision, "decline")``

- **KEEP** ``an unmapped request type still produces a row, with no requestKind`` (baseline line 99). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.ok(row)``; ``assert.equal(payloadOf(row).requestKind, undefined)``; ``assert.equal(payloadOf(row).requestType, "dynamic_tool_call")``

- **KEEP** ``an approval: one 'Request cancelled' row, on the turn its card rode`` (baseline line 116). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(rest, [])``; ``assert.ok(row)``; ``assert.equal(row.activityKind, "approval.resolved")``; ``assert.equal(row.turnId, "turn-3")``; ``assert.deepEqual(row.payload, { requestId: "req-7", decision: "cancel" })``

- **KEEP** ``a question: one 'Question cancelled' row, turnless when its card was`` (baseline line 131). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(rest, [])``; ``assert.ok(row)``; ``assert.equal(row.activityKind, "user-input.resolved")``; ``assert.equal(row.turnId, null)``; ``assert.deepEqual(row.payload, { requestId: "q-7" })``

- **KEEP** ``a withdrawn tool_user_input resolution is still no row: a question closes by its own event`` (baseline line 146). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual( runtimeEventToActivities( runtimeEvent( "request.resolved", { requestType: "tool_user_input", decision: "cancel", withdrawn: true }, { requestId: "q-8" } ) ), [] )``

- **KEEP** ```${itemType} produces tool.started / tool.updated / tool.completed``` (baseline line 163). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(kinds, ["tool.started", "tool.updated", "tool.completed"])``

- **KEEP** ```${itemType} is dropped from the activity path``` (baseline line 186). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(runtimeEventToActivities(runtimeEvent(type, { itemType })), [])``

- **KEEP** ``toolUseId is stable across a call's whole lifecycle`` (baseline line 193). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(ids, ["call-42", "call-42", "call-42"])``

- **KEEP** ``agentId, parentToolUseId and status are promoted out of the payload`` (baseline line 205). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.ok(row)``; ``assert.equal(row.agentId, "agent-7")``; ``assert.equal(row.parentToolUseId, "parent-1")``; ``assert.equal(row.status, "failed")``

- **KEEP** ``an item whose adapter stored only a head of its output says so on the row (`truncated`, §5.6)`` (baseline line 224). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(payloadOf(cut!).truncated, true)``; ``assert.equal("truncated" in payloadOf(whole!), false)``

- **KEEP** ``thread.token-usage.updated becomes context-window.updated`` (baseline line 252). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.ok(row)``; ``assert.equal(row.activityKind, "context-window.updated")``; ``assert.equal(payloadOf(row).usedTokens, 1200)``; ``assert.equal(payloadOf(row).maxTokens, 200_000)``

- **KEEP** ``a negative usedTokens is dropped`` (baseline line 264). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual( runtimeEventToActivities( runtimeEvent("thread.token-usage.updated", { usage: { usedTokens: -1 } }) ), [] )``

- **KEEP** ``only the compacted thread state produces a row, and it carries the token counts`` (baseline line 273). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.ok(row)``; ``assert.equal(row.activityKind, "context-compaction")``; ``assert.equal(payloadOf(row).beforeTokens, 120_000)``; ``assert.equal(payloadOf(row).afterTokens, 18_000)``; ``assert.deepEqual(runtimeEventToActivities(runtimeEvent("thread.state.changed", { state })), [])``

- **KEEP** ``the compaction PHASE is a row too, so a /compact turn is not a blank 'Working'`` (baseline line 290). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(rest, [])``; ``assert.ok(opening)``; ``assert.equal(opening.tone, "info")``; ``assert.equal(opening.activityKind, "context-compaction")``; ``assert.equal(payloadOf(opening).state, "compacting")``; ``assert.equal(payloadOf(opening).requestId, "req-9")``; ``assert.equal(payloadOf(opening).beforeTokens, undefined)``

- **KEEP** ``carries the provider's summary, whole, so the marker can reveal it`` (baseline line 305). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.ok(row)``; ``assert.equal( payloadOf(row).summary, summary, "untruncated on disk: the wire cap is the slimmer's job, and `GET …/items/:itemId` serves this" )``

- **KEEP** ``a failed compaction is an error row carrying the provider's own reason`` (baseline line 323). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(rest, [])``; ``assert.ok(row)``; ``assert.equal(row.tone, "error")``; ``assert.equal(row.activityKind, "context-compaction")``; ``assert.equal(payloadOf(row).state, "compaction-failed")``; ``assert.equal(payloadOf(row).error, "Not enough context to compact.")``

- **KEEP** ```${type} carries the whole linkage bundle``` (baseline line 353). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(payload.agentKind, "agent")``; ``assert.equal(payload[key], value, `${type} lost ${key}`)``

- **KEEP** ``task.started keeps an agent's launch prompt verbatim — never the 180-character detail cap`` (baseline line 369). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.ok(prompt.length > 180 && prompt.length < 32_000)``; ``assert.equal(payload.prompt, prompt)``; ``assert.equal("promptTruncated" in payload, false, "a whole prompt is not marked cut")``; ``assert.equal(payload.detail, "Read b.txt first word")``

- **KEEP** ``task.started keeps a prompt of exactly 32_000 whole, and cuts a longer one there`` (baseline line 389). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(payloadOf(whole!).prompt, exact)``; ``assert.equal("promptTruncated" in payloadOf(whole!), false)``; ``assert.equal(payloadOf(cut!).prompt, exact, "the head, at the cap, with no marker text inside it")``; ``assert.equal(payloadOf(cut!).promptTruncated, true)``

- **KEEP** ``task.started never cuts a prompt through a surrogate pair`` (baseline line 404). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(stored, "p".repeat(32_000 - 1))``; ``assert.equal(payloadOf(row!).promptTruncated, true)``; ``assert.equal(payloadOf(kept!).prompt, `${"p".repeat(32_000 - 2)}😀`)``; ``assert.equal(payloadOf(kept!).promptTruncated, true)``

- **KEEP** ``task.started without a prompt, or with a blank one, has no prompt key`` (baseline line 424). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal("prompt" in payload, false, `prompt ${JSON.stringify(prompt)} was written`)``; ``assert.equal("promptTruncated" in payload, false)``

- **KEEP** ``task.progress splits activity and usage onto two stable ids`` (baseline line 439). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(rows.length, 2)``; ``assert.equal(rows[0]!.id, "task-progress:t1:task-1")``; ``assert.equal(rows[1]!.id, "task-usage:t1:task-1")``; ``assert.equal(payloadOf(rows[1]!).usageSnapshot, true)``; ``assert.equal(payloadOf(rows[1]!).status, undefined)``

- **KEEP** ``a usage-only task.progress produces the usage row alone`` (baseline line 457). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(rows.length, 1)``; ``assert.equal(rows[0]!.id, "task-usage:t1:task-1")``

- **DELETE** ``a failed task row is toned error`` (baseline line 469). Appearance-only tone assertion; never checks the failed task state or error data. Retained task linkage/lifecycle and fold roster tests own failed-task behavior.

- **KEEP** ``task.completed carries a shell's exit code — a signal's negative one included`` (baseline line 476). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(payloadOf(row!).exitCode, exitCode, `exit code ${exitCode}`)``; ``assert.equal("exitCode" in payloadOf(unreported!), false, "no code reported, none written")``

- **KEEP** ``task.completed carries the adapter's left-running marker, and only when set`` (baseline line 494). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(payloadOf(marked!).leftRunning, true)``; ``assert.equal("leftRunning" in payloadOf(plain!), false)``

- **KEEP** ``parent-conversation tool.progress is ephemeral; only agent-owned heartbeats persist`` (baseline line 512). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual( runtimeEventToActivities(runtimeEvent("tool.progress", { toolUseId: "tu-1" })), [] )``; ``assert.ok(row)``; ``assert.equal(row.id, "tool-progress:t1:task-1")``; ``assert.equal(row.summary, "Bash")``

- **DELETE** ``tool.denied is an error row`` (baseline line 525). Appearance-only tone assertion without denial data or pending-state behavior. Denial/approval semantics remain in adapter and pending/fold contracts.

- **KEEP** ``runtime.error keeps its class; runtime.warning uses the message as the label`` (baseline line 533). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(error!.tone, "error")``; ``assert.equal(payloadOf(error!).class, "provider_error")``; ``assert.equal(warning!.tone, "info")``; ``assert.equal(warning!.summary, "unmapped frame xyz")``

- **KEEP** ``an account failure's reason and reset reach the activity payload (workflows §5.4)`` (baseline line 547). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(payloadOf(error!).reason, "usage_limit")``; ``assert.equal(payloadOf(error!).resetsAt, "2026-09-28T22:40:00.000Z")``; ``assert.equal(payloadOf(warning!).reason, "auth")``; ``assert.equal("resetsAt" in payloadOf(warning!), false)``; ``assert.deepEqual(payloadOf(plain!), { message: "boom", class: "provider_error" })``

- **KEEP** ``hooks, plans and reroutes become rows`` (baseline line 572). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal( runtimeEventToActivities( runtimeEvent("hook.started", { hookId: "h1", hookName: "fmt", hookEvent: "PostToolUse" }) )[0]?.activityKind, "hook.started" )``; ``assert.equal(failed!.tone, "error")``; ``assert.equal( runtimeEventToActivities( runtimeEvent("turn.plan.updated", { plan: [{ step: "a", status: "pending" }] }) )[0]?.activityKind, "turn.plan.updated" )``; ``assert.equal( runtimeEventToActivities( runtimeEvent("model.rerouted", { fromModel: "a", toModel: "b", reason: "quota" }) )[0]?.activityKind, "model.rerouted" )``

- **KEEP** ``questions become their own rows`` (baseline line 597). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(requested!.activityKind, "user-input.requested")``; ``assert.equal(payloadOf(requested!).dismissible, true)``; ``assert.equal(resolved!.activityKind, "user-input.resolved")``

- **KEEP** ``one thread.goal.updated is ONE goal.updated row carrying the payload verbatim`` (baseline line 623). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(rows.length, 1)``; ``assert.equal(row!.id, "re-goal")``; ``assert.equal(row!.activityKind, "goal.updated")``; ``assert.equal(row!.tone, "info")``; ``assert.equal(row!.turnId, "turn-7")``; ``assert.deepEqual(row!.payload, payload)``

- **KEEP** ``a goal outside a turn is turnless, and no row ever names an agent`` (baseline line 638). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(row!.turnId, null)``; ``assert.equal(row!.agentId, undefined)``; ``assert.equal("agentId" in payloadOf(row!), false)``

- **DELETE** ``only a failed goal is error-toned`` (baseline line 652). Appearance-only color/tone mapping table. Retained goal payload, history exclusion and progress-fold contracts own user-visible goal state.

- **KEEP** ``a cleared goal's row keeps the goal that ended, verbatim`` (baseline line 661). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(row!.payload, { goal: null, change: "cleared", previous: goal })``

- **KEEP** ``a goal event replayed out of the provider's history produces nothing`` (baseline line 668). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual( runtimeEventToActivities( runtimeEvent( "thread.goal.updated", { goal, change: "restored" }, { raw: { source: HISTORICAL_RAW_SOURCE, payload: {} } } ) ), [] )``

- **DELETE** ``session, turn and content events produce no activity of their own`` (baseline line 686). Pins an internal translator split rather than the resulting transcript. Retained ingestion index mandatory flush/status/message tests assert complete emitted event sequences and history.test.ts asserts transcript behavior.



## `apps/daemon/src/agent-host/ingestion/assistant-phase.test.ts`

Independent source (B1): GUI design §7.3 message kinds and fixture-observed Codex abandoned-message regression: phase metadata must not swallow literal phase-word replies or glue an answer to abandoned commentary; owner isolation persists.

Stable seam and refactor tolerance (B4–B5): Real createIngestion plus API fold; Codex wire normalizer/history projector where the capture is the oracle. No test-only implementation branch is required.

Non-test callers: All provider streams -> ingestion; GUI timeline and MCP lastReply read folded messages.

Lowest distinct owner / remaining stronger coverage (B6): Capture replay uniquely joins provider phase, host segmentation and persisted text. Synthetic cases exercise absent metadata, missing completion and owner interactions not covered by another retained owner.

Cases below name their recognizable failure; “oracle” records the original concrete expected output/state checks (B2–B3), inspected before editing. For REWRITE, the disposition explains which assertion/seam changes; the external contract remains the same.

- **KEEP** ``never drops a replayed message whose whole text is its own phase word`` (baseline line 204). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(seen(messages.get("assistant:a1")), { text: "commentary", messageKind: "commentary" })``; ``assert.deepEqual(seen(messages.get("assistant:a2")), { text: "final_answer", messageKind: "answer" })``

- **KEEP** ```live, streamed then completed (OpenCode's shape): ${JSON.stringify(text)}``` (baseline line 238). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(seen(messages.get("assistant:part-1")), { text, messageKind: "answer" })``

- **KEEP** ```live, a completion standing in for deltas that never came: ${JSON.stringify(text)}``` (baseline line 259). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(seen(messages.get("assistant:part-1")), { text, messageKind: "answer" })``

- **KEEP** ```history (Grok's and OpenCode's shape): ${JSON.stringify(text)}``` (baseline line 277). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(seen(messages.get("assistant:a1")), { text, messageKind: "answer" })``

- **KEEP** ``every capture: each assistant bubble is ONE recorded agentMessage, of its phase, with its own text`` (baseline line 355). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.ok(phases.has(itemId), `${name}: ${bubble.id} is not a recorded agentMessage`)``; ``assert.equal(bubble.messageKind, expected, `${name} ${bubble.id}`)``; ``assert.equal( bubble.text, completedTexts.get(itemId) ?? streamedTexts.get(itemId), `${name} ${bubble.id}` )``; ``assert.ok(bubbles.has(`assistant:${itemId}`), `${name}: ${itemId} has no bubble`)``

- **KEEP** ``(a) abandoned commentary, then the final answer: two messages, and lastReply reads the answer alone`` (baseline line 418). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual( events.flatMap((event) => event.type === "item.completed" && event.itemId === "msg-a" ? [event.payload] : [] ), [{ itemType: "assistant_message", status: "completed" }] )``; ``assert.deepEqual( [...messages.values()].filter((message) => message.role === "assistant").map((message) => message.id), ["assistant:msg-a", "assistant:msg-b"] )``; ``assert.deepEqual(seen(messages.get("assistant:msg-a")), { text: fragment, messageKind: "commentary" })``; ``assert.deepEqual(seen(messages.get("assistant:msg-b")), { text: answer, messageKind: "answer" })``; ``assert.equal(closeA.length, 1)``; ``assert.ok(closeA[0]!.index < messageRows(domain, "assistant:msg-b")[0]!.index)``

- **KEEP** ``(c) a restarted SAME item keeps its one message`` (baseline line 461). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual([...messages.keys()], ["assistant:msg-a"])``; ``assert.deepEqual(seen(messages.get("assistant:msg-a")), { text: "Hello, world.", messageKind: "commentary" })``; ``assert.deepEqual( rows.filter((row) => !row.streaming).map((row) => row.index), [rows.at(-1)!.index] )``

- **KEEP** ``(c) an item.started that names no item proves no abandonment`` (baseline line 487). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(seen(foldMessages(domain).get("assistant:msg-a")), { text: "Hello, world.", messageKind: "answer" })``; ``assert.deepEqual( rows.filter((row) => !row.streaming).map((row) => row.index), [rows.at(-1)!.index] )``

- **KEEP** ``(c) a subagent's assistant item leaves the parent's open message alone`` (baseline line 507). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(seen(messages.get("assistant:msg-p")), { text: "Parent, continued.", messageKind: "answer" })``; ``assert.equal(messages.get("assistant:agent:task-1:msg-s")?.text, "Agent says")``; ``assert.equal(messages.get("assistant:agent:task-1:msg-s")?.agentId, "task-1")``; ``assert.deepEqual( rows.filter((row) => !row.streaming).map((row) => row.index), [rows.at(-1)!.index], "the parent's message is closed once, by its own completion" )``

- **KEEP** ``(c) …and a parent's new item leaves a subagent's open message alone`` (baseline line 537). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(messages.get("assistant:agent:task-1:msg-s")?.text, "Agent continues.")``; ``assert.equal(messages.get("assistant:msg-p")?.text, "Parent.")``; ``assert.deepEqual( rows.filter((row) => !row.streaming).map((row) => row.index), [rows.at(-1)!.index], "the agent's message is closed once, by its own completion" )``

- **KEEP** ``data.text stands in for deltas that never arrived, even beside a marker detail`` (baseline line 565). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(seen(messages.get("assistant:a1")), { text: "I'll read the config first.", messageKind: "commentary" })``

- **KEEP** ``…and never prints a streamed message twice`` (baseline line 587). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(seen(messages.get("assistant:a1")), { text: "I'll read the config first.", messageKind: "commentary" })``



## `apps/daemon/src/agent-host/ingestion/coalesce.test.ts`

Independent source (B1): GUI design §5.6 snapshot matching within a turn, latest valid context usage, and 16 KiB wire slimming with recoverable full output.

Stable seam and refactor tolerance (B4–B5): projectSnapshotActivities and slimActivityEvent read-side projections. No test-only implementation branch is required.

Non-test callers: Orchestrator snapshot/history reads and server event stream.

Lowest distinct owner / remaining stronger coverage (B6): Snapshot drops and wire projection differ from ingestion write coalescing; API slimmer tests do not prove every read path invokes slimming or the turn-aware drops.

Cases below name their recognizable failure; “oracle” records the original concrete expected output/state checks (B2–B3), inspected before editing. For REWRITE, the disposition explains which assertion/seam changes; the external contract remains the same.

- **KEEP** ``reads a nested data.toolUseId too`` (baseline line 31). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(rows.map((row) => row.id), ["complete"])``

- **KEEP** ``drops an update a LATER completion in the same turn supersedes`` (baseline line 41). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual( kept.map((row) => row.id), ["d1", "d2", "u3"] )``

- **KEEP** ``does not drop across turns`` (baseline line 56). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(kept.length, 2)``

- **KEEP** ``falls back to the itemType/label/detail triple, normalising a trailing 'complete'`` (baseline line 64). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual( projectSnapshotActivities([update, completion]).map((row) => row.id), ["d1"] )``

- **KEEP** ``slims a row on its way out, and stamps truncated`` (baseline line 103). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.ok(row)``; ``assert.equal(payload.truncated, true, "'load full output' needs this flag")``

- **KEEP** ``slimActivityEvent slims an activity event and passes everything else through`` (baseline line 114). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(slimActivityEvent(other), other)``; ``assert.deepEqual(slimActivityEvent(small), small)``

- **KEEP** ``keeps only the newest resolvable row per turn`` (baseline line 136). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual( kept.map((row) => row.id), ["c2", "c3", "t1"] )``

- **KEEP** ``a malformed row passes through and never shadows a valid earlier one`` (baseline line 149). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual( kept.map((row) => row.id), ["c1", "c2"] )``



## `apps/daemon/src/agent-host/ingestion/fold-integration.test.ts`

Independent source (B1): GUI design §§5.1, 7.3, 7.6; regression evidence in Claude fixture observations and Codex/OpenCode runtime shapes: correct status/usage, retained agent relaunches, call ownership and rewind behavior.

Stable seam and refactor tolerance (B4–B5): Canonical runtime events (or real Claude normalizer output) -> ingestion -> real API fold/transcript. No test-only implementation branch is required.

Non-test callers: Host ingestion commit, GUI snapshot fold and MCP transcript reader.

Lowest distinct owner / remaining stronger coverage (B6): Retain only cross-contract failure modes and the distinct legacy omitted-messageKind regression; duplicate stable-ID task replacement is deleted. API agent confirmed no lower test covers omitted messageKind.

Cases below name their recognizable failure; “oracle” records the original concrete expected output/state checks (B2–B3), inspected before editing. For REWRITE, the disposition explains which assertion/seam changes; the external contract remains the same.

- **KEEP** ``the turn settles from session status, and the head tracks the session`` (baseline line 100). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(state.head?.session.status, "ready")``; ``assert.equal(state.head?.session.activeTurnId, null)``; ``assert.equal(state.head?.session.providerThreadId, "prov-9")``; ``assert.ok(turn, "the turn must exist after folding")``; ``assert.equal(turn.state, "completed")``

- **KEEP** ``a background shell folds as background, not as a subagent`` (baseline line 124). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.ok(agent)``; ``assert.equal(agent.agentKind, "background")``

- **DELETE** ``a task.progress row replaces the previous one instead of piling up`` (baseline line 140). Duplicate integration of stable task IDs and API activity upsert. Retained activities.test.ts `task.progress splits activity and usage onto two stable ids` owns translation; packages/api/src/agent-chat/fold.test.ts `an activity with a known id is replaced in place, not appended` owns replacement (confirmed with API agent).

- **KEEP** ``goal progress rows collapse into one, and the goal follows every replacement`` (baseline line 160). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual( goalRows.map((row) => row.id).filter((id) => id.startsWith("goal-progress:")), [`goal-progress:${THREAD_ID}`], "one progress row, however many ticks" )``; ``assert.equal(goalRows.length, 2, "the set row and the one progress row")``; ``assert.equal(state.goal?.rounds, 3, "the goal follows the in-place replacement")``; ``assert.ok( ids.indexOf(`goal-progress:${THREAD_ID}`) < ids.indexOf("tool-1"), "the row keeps the position its first tick took" )``

- **KEEP** ``a later delta that omits the fields never strips them`` (baseline line 197). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(messages(state)[0]?.messageKind, "commentary")``; ``assert.equal(messages(state)[0]?.messageKind, "commentary")``; ``assert.equal(messages(state)[0]?.text, "one\n\ntwo")``

- **KEEP** ```E3/R5 #2: a user Stop via ${label} settles the turn INTERRUPTED``` (baseline line 250). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.ok(turn)``; ``assert.equal(turn.state, "interrupted", "a Stop is never a completed turn")``; ``assert.equal(state.head?.session.status, "stopped")``; ``assert.equal(state.head?.session.lastError, undefined, "a Stop is not an error")``

- **KEEP** ``E10: turn.completed's tokenUsage and cost reach Turn`` (baseline line 275). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.ok(turn)``; ``assert.equal(turn.state, "completed")``; ``assert.equal(turn.tokenUsage?.usageStatus, "complete")``; ``assert.equal(turn.tokenUsage?.inputTokens, 28_784)``; ``assert.equal(turn.tokenUsage?.outputTokens, 64)``; ``assert.equal(turn.totalCostUsd, 0.0412)``

- **KEEP** ``E10: an interrupted turn keeps the usage it managed to report`` (baseline line 307). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(turn?.state, "interrupted")``; ``assert.equal(turn?.tokenUsage?.usageStatus, "partial")``; ``assert.equal(turn?.tokenUsage?.inputTokens, 120)``

- **KEEP** ``E10: a replayed terminal event never rewrites a settled turn's numbers`` (baseline line 332). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(turn?.totalCostUsd, 1)``; ``assert.equal(turn?.tokenUsage?.inputTokens, 10)``

- **KEEP** ```${shape.adapter}: a relaunched run survives 300 agent-owned tool calls``` (baseline line 482). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(state.evicted?.activities, true, "the agent's window was trimmed")``; ``assert.ok( !state.activities.some((row) => row.activityKind === "task.updated"), "every status row of both runs is gone" )``; ``assert.equal(agent.status, "running")``; ``assert.equal(agent.activationCount, 2)``

- **KEEP** ``a background agent's call keeps one turn and one owner past the parent's result, and its words settle`` (baseline line 518). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual( rows.map((row) => row.activityKind), ["tool.started", "tool.updated", "tool.output", "tool.completed"], `${callId}: started, its result, its output, its end — once each` )``; ``assert.deepEqual( [...new Set(rows.map((row) => `${row.turnId}|${row.agentId}`))], [`${turnId}|task-A`], `${callId}: one call, one turn key, one owner` )``; ``assert.equal(completed.status, "completed", `${callId} finished for real`)``; ``assert.ok( (completed.payload as { data?: { result?: unknown } }).data?.result !== undefined, `${callId}'s completion carries its real result` )``; ``assert.deepEqual( agentMessages.map((message) => [message.role, message.text, message.turnId, message.streaming]), [ ["reasoning", "Both files are there.", null, false], ["assistant", "Found a.txt and b.txt.", null, false] ], "a background agent's words settle between parent turns" )``

- **KEEP** ``a woken parent's call rides its synthetic turn — its held stream replayed into it — and a rewind to before that turn removes it`` (baseline line 632). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.ok(synthetic, "the woken parent's answer is a turn of its own")``; ``assert.deepEqual(rowsOf(live), [ ["tool.started", synthetic], ["tool.updated", synthetic] ])``; ``assert.deepEqual(entriesOf(live), [["inProgress", "cat out.txt"]])``; ``assert.deepEqual(rowsOf(state), [ ["tool.started", synthetic], ["tool.updated", synthetic], ["tool.output", synthetic], ["tool.completed", synthetic] ])``; ``assert.deepEqual(entriesOf(state), [["completed", "cat out.txt"]])``; ``assert.deepEqual(rowsOf(reverted), [])``; ``assert.deepEqual(entriesOf(reverted), [])``; ``assert.deepEqual(closings.map((closing) => closing.key), [])``; ``assert.deepEqual(rowsOf(reloaded), [])``; ``assert.deepEqual(entriesOf(reloaded), [])``

- **KEEP** ``a call an interrupted message's tail streams after its turn ended is that turn's, closed on it — the next turn holds none of it`` (baseline line 766). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(state.turns.map((turn) => turn.turnId), ["turn-1", "turn-2"])``; ``assert.deepEqual(rowsOf(state), [ ["tool.started", "turn-1"], ["tool.completed", "turn-1"] ])``; ``assert.deepEqual(statusOf(state), [[1, "failed"]], "a call of the interrupted turn, never running")``; ``assert.deepEqual(rowsOf(reverted), [ ["tool.started", "turn-1"], ["tool.completed", "turn-1"] ])``; ``assert.deepEqual(closings.map((closing) => closing.key), [])``



## `apps/daemon/src/agent-host/ingestion/history.test.ts`

Independent source (B1): GUI design §§4.5 and 5.1 historical transcript projection: replay rebuilds completed history without changing live session, title, liveness, checkpoints or duplicating prompts.

Stable seam and refactor tolerance (B4–B5): createIngestion with historical runtime marker -> emitted domain facts and real fold. No test-only implementation branch is required.

Non-test callers: All native history adapters on resume; host ingestion.

Lowest distinct owner / remaining stronger coverage (B6): Historical/live branch semantics belong here; provider history tests own wire decoding and API fold tests do not know the runtime historical marker.

Cases below name their recognizable failure; “oracle” records the original concrete expected output/state checks (B2–B3), inspected before editing. For REWRITE, the disposition explains which assertion/seam changes; the external contract remains the same.

- **KEEP** ``a historical turn settles WITHOUT touching session status`` (baseline line 122). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal( sink.ofType("thread.session-set").length, 0, "history must not move the live session" )``; ``assert.equal(state.head?.session.status, "idle")``; ``assert.ok(turn, "the replayed turn produced no row")``; ``assert.equal(turn.state, "completed")``; ``assert.equal(turn.tokenUsage?.usageStatus, "unavailable")``; ``assert.equal(turn.completedAt, "2026-09-21T10:00:00.000Z")``; ``assert.equal(turn.assistantMessageId, "assistant:a1")``

- **KEEP** ``a half-replayed transcript leaves NO running turn`` (baseline line 164). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(fold(sink.events()).turns.length, 0)``

- **KEEP** ``an interrupted historical turn replays as interrupted, not completed`` (baseline line 169). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(fold(sink.events()).turns[0]?.state, "interrupted")``

- **KEEP** ``history feeds neither liveness nor the checkpoint service`` (baseline line 177). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(liveness.liveAgentCount(THREAD_ID), 0, "a replayed task is not live work")``; ``assert.deepEqual(checkpointCalls, [], "history never invokes checkpoint creation")``; ``assert.equal(sink.ofType("thread.turn-diff-completed").length, 0)``

- **KEEP** ``a replayed provider name never retitles the thread`` (baseline line 191). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(sink.ofType("thread.meta-updated").length, 0)``

- **KEEP** ``replayed messages are complete, never streaming`` (baseline line 198). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(roleText(sink.events()), ["user:hi", "reasoning:thinking"])``; ``assert.equal(message.payload.streaming, false)``; ``assert.equal(message.streaming, false)``; ``assert.equal(message.attachments, undefined, "the bytes are long gone")``; ``assert.equal(message.context, undefined, "composer chips were never in the transcript")``

- **KEEP** ``the FULL text wins over an elided detail`` (baseline line 222). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(roleText(sink.events()), [ "user:the beginning, the middle and the end" ])``

- **KEEP** ``one user message per replayed turn, however many items echo it`` (baseline line 242). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(roleText(sink.events()), ["user:once"])``

- **KEEP** ``a replayed tool call is still an activity row`` (baseline line 260). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(sink.activityKinds(), ["tool.completed"])``; ``assert.equal( (sink.activities()[0]!.payload.activity.payload as { toolUseId: string }).toolUseId, "call-1" )``

- **KEEP** ``replaying the same transcript twice rewrites the rows, never duplicates them`` (baseline line 275). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual( messages(first.sink.events()).map((message) => message.id), messages(second.sink.events()).map((message) => message.id) )``; ``assert.equal(messages([...first.sink.events(), ...second.sink.events()]).length, 1)``

- **KEEP** ``the provider echoing the prompt does not duplicate what /turn appended`` (baseline line 296). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(sink.messages(), [])``



## `apps/daemon/src/agent-host/ingestion/index.test.ts`

Independent source (B1): GUI design §§3.1, 5.1, 5.4, 5.6, 7.3, 7.6 and 10: stable identities, bounded streaming/coalescing, flush ordering, session/title/account separation, attribution and robustness. Named R5/Q1 cases document credible data-loss/duplication regressions.

Stable seam and refactor tolerance (B4–B5): Public Ingestion service operations ingest/flush/drain/forget and emitted DomainEvent sink; real liveness where its externally readable count matters. No test-only implementation branch is required.

Non-test callers: main.ts creates ingestion with orchestrator sink, head context, checkpoint and provider-snapshot hooks.

Lowest distinct owner / remaining stronger coverage (B6): Stateful translation/buffering is the lowest seam observing runtime-to-domain ordering. Stateless mappings remain in activities tests; API folding and transport emission are separate contracts. Redundant sequential ordering smoke test is deleted.

Cases below name their recognizable failure; “oracle” records the original concrete expected output/state checks (B2–B3), inspected before editing. For REWRITE, the disposition explains which assertion/seam changes; the external contract remains the same.

- **KEEP** ``falls back to the turn id, then the event id`` (baseline line 123). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(messageTexts(a.sink)[0]?.id, "assistant:turn-7")``; ``assert.equal(messageTexts(b.sink)[0]?.id, "assistant:ev-42")``

- **KEEP** ``a summary trace and a raw trace over one item become two reasoning messages`` (baseline line 145). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(ids, ["reasoning:summary:item-1", "reasoning:raw:item-1:segment:1"])``

- **KEEP** ``a delta carries ONLY the new text and a completion carries empty text`` (baseline line 161). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(messageTexts(sink), [ { id: "assistant:item-1", text: "one\n\n", streaming: true }, { id: "assistant:item-1", text: "two\n\n", streaming: true }, { id: "assistant:item-1", text: "", streaming: false } ])``

- **KEEP** ``holds a partial line until the 250 ms window expires`` (baseline line 187). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(sink.messages().length, 0, "nothing should have been written yet")``; ``assert.deepEqual(messageTexts(sink), [ { id: "assistant:item-1", text: "partial", streaming: true } ])``

- **KEEP** ``delivers early on a paragraph boundary once the pacing window has passed`` (baseline line 204). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(messageTexts(sink)[0]?.text, "one\n\n")``; ``assert.equal(sink.messages().length, 0, "a second paragraph inside 250 ms stays buffered")``; ``assert.equal(messageTexts(sink)[0]?.text, "two\n\n")``

- **KEEP** ``never splits a code block: an open fence holds past the window`` (baseline line 222). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(sink.messages().length, 0, "an unclosed fence must not be flushed")``; ``assert.equal(messageTexts(sink)[0]?.text, "` ``ts\nconst a = 1;\n` ``\n")``

- **KEEP** ``the 8 KB valve wins over the fence rule`` (baseline line 243). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(sink.messages().length, 1)``; ``assert.ok(messageTexts(sink)[0]!.text.length > 8192)``

- **KEEP** ``reasoning deltas are buffered on the same machinery`` (baseline line 260). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(sink.messages().length, 0)``; ``assert.deepEqual(messageTexts(sink), [ { id: "reasoning:raw:item-1", text: "thinking", streaming: true } ])``

- **KEEP** ``a new reasoning part index inserts the blank line that separates traces`` (baseline line 277). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal( messageTexts(sink) .map((m) => m.text) .join(""), "part one\n\npart two" )``

- **KEEP** ``command output deltas are buffered per item id (§5.6)`` (baseline line 303). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(rows.length, 2)``; ``assert.deepEqual( rows.map((row) => (row.payload.activity.payload as { toolUseId: string }).toolUseId).sort(), ["call-a", "call-b"] )``

- **KEEP** ``request.opened flushes AND finalises before the approval row is appended`` (baseline line 336). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(sink.messages().length, 0, "buffered, not yet written")``; ``assert.deepEqual(types, [ "thread.message-sent:true", "thread.message-sent:false", "approval.requested" ])``

- **KEEP** ``a BLOCKING user-input.requested flushes; a message-mode one does not`` (baseline line 364). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(blocking.sink.messages().length, 2)``; ``assert.equal( message.sink.messages().length, 0, "a message-mode question does not block the provider, so it must not force a flush" )``

- **KEEP** ``a completion NEVER re-sends text that a prompt already closed`` (baseline line 393). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal( foldedMessageText(sink, "assistant:item-1"), text, `${pause.type}: the folded bubble holds the text exactly once` )``; ``assert.deepEqual( messageTexts(sink), [ { id: "assistant:item-1", text, streaming: true }, { id: "assistant:item-1", text: "", streaming: false } ], `${pause.type}: the prompt already sent the close, so the completion writes nothing` )``

- **KEEP** ``the prompt-closed record is per turn: another turn's snapshot still stands in`` (baseline line 443). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(messageTexts(sink), [ { id: "assistant:item-1", text: "turn two", streaming: true }, { id: "assistant:item-1", text: "", streaming: false } ])``

- **KEEP** ``a tool item.started closes the active reasoning segment`` (baseline line 479). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(messageTexts(sink), [ { id: "reasoning:raw:item-1", text: "pondering", streaming: true }, { id: "reasoning:raw:item-1", text: "", streaming: false } ])``; ``assert.equal(messageTexts(sink).at(-1)?.id, "reasoning:raw:item-2:segment:1")``

- **KEEP** ``a NON-tool item.started leaves the thinking block open`` (baseline line 508). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(sink.messages().length, 0)``; ``assert.equal( messageTexts(sink) .map((m) => m.text) .join(""), "pondering more" )``

- **KEEP** ``assistant text closes the thinking block that preceded it`` (baseline line 535). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual( messageTexts(sink).map((m) => `${m.id}/${m.streaming}`), ["reasoning:raw:item-1/true", "reasoning:raw:item-1/false"] )``

- **KEEP** ``a settled turn flushes and closes everything it opened`` (baseline line 550). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(order, [ "thread.message-sent", "thread.message-sent", "thread.session-set" ])``; ``assert.equal( sink.ofType("thread.session-set")[0]?.payload.session.activeTurnId, null, "the text must land before the status change that settles the turn" )``

- **KEEP** ``collapses a burst for one call to the latest row`` (baseline line 586). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(sink.activities().length, 0, "the window is still open")``; ``assert.equal(rows.length, 1)``; ``assert.equal((rows[0]!.payload.activity.payload as { detail: string }).detail, "c")``

- **KEEP** ``coalesces per turn, not per thread`` (baseline line 599). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(activityOfKind(sink, "tool.updated").length, 2)``

- **KEEP** ``a call with no stable id passes through unchanged`` (baseline line 608). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(activityOfKind(sink, "tool.updated").length, 2)``

- **KEEP** ``any non-update event closes the window immediately, so ordering is preserved`` (baseline line 624). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(sink.activityKinds(), ["tool.updated", "tool.completed"])``

- **KEEP** ``512 pending rows close the window early`` (baseline line 638). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal( activityOfKind(sink, "tool.updated").length, 512, "the cap must flush without waiting for the timer" )``

- **KEEP** ``drain flushes a window that has not expired`` (baseline line 650). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(sink.activities().length, 0)``; ``assert.equal(activityOfKind(sink, "tool.updated").length, 1)``

- **KEEP** ```${streamKind} -> reasoningKind ${expected}``` (baseline line 672). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.ok(rows.length >= 2, "a delta and a completion")``; ``assert.equal(row.payload.role, "reasoning")``; ``assert.equal(row.payload.reasoningKind, expected, "every row must carry the badge")``; ``assert.equal(row.payload.messageKind, undefined, "messageKind is assistant-only")``

- **KEEP** ``a whole-block reasoning snapshot carries NO reasoningKind`` (baseline line 689). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(rows.map((row) => row.payload.text).join(""), "I thought about it")``; ``assert.ok(rows.every((row) => row.payload.reasoningKind === undefined))``

- **KEEP** ``the phase stamps a message that ALREADY started streaming`` (baseline line 706). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(sink.messages()[0]?.payload.messageKind, "answer", "not known yet")``; ``assert.ok(rows.length > 0)``; ``assert.equal(row.payload.messageKind, "commentary")``

- **REWRITE** ``a dead session forgets the remembered phases`` (baseline line 733). Replace the vacuous loop with positive fresh-text and answer-kind assertions; dropping every post-exit message must fail. Same documented session-state reset contract, observed at Ingestion sink.

  Oracle: ``assert.equal(row.payload.messageKind, "answer")``

- **KEEP** ``writes nothing to the thread and hands them to the host instead`` (baseline line 760). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(sink.events().length, 0, "neither event is a thread fact")``; ``assert.deepEqual(routed, ["auth.status", "account.rate-limits.updated"])``

- **KEEP** ``a throwing host hook never escapes ingest`` (baseline line 780). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.ok(warnings.length > 0)``

- **KEEP** ``a tool.updated row reaches the log slimmed, the completion in full`` (baseline line 795). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.ok( updatedJson.length < 2_000, `the streaming update must not persist the whole output (was ${updatedJson.length} bytes)` )``; ``assert.ok( completedJson.length > 40_000, "the completion is what a 'load full output' fetch reads, so it keeps everything" )``; ``assert.equal( (updated!.payload.activity.payload as { toolUseId?: string }).toolUseId, "call-1" )``; ``assert.equal( (updated!.payload.activity.payload as { itemType?: string }).itemType, "command_execution" )``

- **KEEP** ``retitles an auto-generated thread`` (baseline line 847). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(sink.ofType("thread.meta-updated")[0]?.payload, { title: "Fix the parser" })``

- **KEEP** ``NEVER overwrites a manual rename`` (baseline line 856). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(sink.ofType("thread.meta-updated").length, 0)``

- **KEEP** ``an empty name is not a rename`` (baseline line 863). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(sink.ofType("thread.meta-updated").length, 0)``

- **KEEP** ``tracks live work until completion or session exit`` (baseline line 872). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(liveness.liveAgentCount("t1"), 1)``; ``assert.equal(liveness.liveAgentCount("t1"), 0)``; ``assert.equal(liveness.liveAgentCount("t1"), 1)``; ``assert.equal(liveness.liveAgentCount("t1"), 0)``; ``assert.equal(liveness.liveAgentCount("t1"), 1)``; ``assert.equal(liveness.liveAgentCount("t1"), 0)``

- **KEEP** ``remembers a task description so the completion row is titled`` (baseline line 899). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal( (completion.payload.activity.payload as { title: string }).title, "Audit the fold" )``

- **KEEP** ``dedupes an unchanged status, so Claude's 3-per-turn status frames write one row`` (baseline line 917). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(sink.ofType("thread.session-set").length, 1)``

- **KEEP** ``runtime.error writes BOTH a session-set and an activity row`` (baseline line 928). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(sink.ofType("thread.session-set")[0]?.payload.session.status, "error")``; ``assert.equal(activityOfKind(sink, "runtime.error").length, 1)``

- **KEEP** ``session.exited flushes buffered text before the stop and forgets the turn state`` (baseline line 938). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(sink.types(), [ "thread.message-sent", "thread.message-sent", "thread.session-set" ])``; ``assert.equal(sink.events().length, 0)``

- **KEEP** ``the head SEEDS the session state, so a restart keeps the active turn`` (baseline line 961). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(session.status, "running")``; ``assert.equal(session.activeTurnId, "turn-restored")``

- **KEEP** ``after seeding, ingestion's own memory wins over a head W1 has not applied yet`` (baseline line 974). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(sessions, [{ status: "running", activeTurnId: "turn-9" }])``

- **KEEP** ``buffers turn.proposed deltas onto one stable row and completes it`` (baseline line 989). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(ids.size, 1, "one stable id, so the card is replaced rather than appended to")``; ``assert.equal(last.payload.activity.activityKind, "turn.proposed.completed")``; ``assert.equal( (last.payload.activity.payload as { planMarkdown: string }).planMarkdown, "# Plan\n- step one\n" )``

- **KEEP** ``plan deltas are BATCHED: a token-by-token plan is not one row per token`` (baseline line 1011). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.ok(rows.length <= 4, `40 plan tokens became ${rows.length} rows`)``; ``assert.equal(new Set(rows.map((row) => row.payload.activity.id)).size, 1)``; ``assert.ok( (rows.at(-1)!.payload.activity.payload as { planMarkdown: string }).planMarkdown.endsWith( "w39 " ) )``

- **KEEP** ``plan_text content deltas feed the same buffer`` (baseline line 1033). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal( (last.payload.activity.payload as { planMarkdown: string }).planMarkdown, "from content" )``

- **KEEP** ``the completion's markdown stands in when nothing was streamed`` (baseline line 1048). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal( (sink.activities()[0]!.payload.activity.payload as { planMarkdown: string }).planMarkdown, "# Whole plan" )``

- **KEEP** ``emits thread.turn-diff-completed when the host resolves a turn count`` (baseline line 1062). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.ok(event)``; ``assert.equal(event.payload.turnCount, 4)``; ``assert.equal(event.payload.status, "missing")``; ``assert.equal(event.payload.ref, "provider-diff:ev-9")``; ``assert.deepEqual(event.payload.files, [])``

- **KEEP** ``emits nothing when the host declines, and nothing when no hook is wired`` (baseline line 1082). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(declined.sink.events().length, 0)``; ``assert.equal(unwired.sink.events().length, 0)``

- **KEEP** ``R5 #3: the placeholder checkpoint never synthesises an assistantMessageId`` (baseline line 1100). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal( sink.ofType("thread.turn-diff-completed")[0]?.payload.assistantMessageId, null )``

- **KEEP** ``R5 #3: it DOES carry the turn's real anchor when one is open`` (baseline line 1119). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal( sink.ofType("thread.turn-diff-completed")[0]?.payload.assistantMessageId, "assistant:msg-1" )``

- **KEEP** ``R5 #7: reasoning with NO turn id is buffered, not silently discarded`` (baseline line 1140). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(messageTexts(sink), [ { id: "reasoning:summary:item-1", text: "early thought", streaming: true }, { id: "reasoning:summary:item-1", text: "", streaming: false } ])``; ``assert.equal(sink.messages()[0]?.payload.turnId, null)``; ``assert.equal(sink.messages()[0]?.payload.reasoningKind, "summary")``

- **KEEP** ``R5 #8: a proposal streamed by a subagent keeps its agentId`` (baseline line 1159). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.ok(rows.length > 0)``; ``assert.equal(row.payload.activity.agentId, "agent-7")``

- **KEEP** ``R5 #9: both output streams of ONE item share one buffer and one row`` (baseline line 1181). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(rows.length, 1, "keyed by item id, not by streamKind + item id")``; ``assert.equal((rows[0]!.payload.activity.payload as { delta: string }).delta, "ab")``

- **KEEP** ``R5 #17: every event is stamped with the thread's adapterKey`` (baseline line 1197). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(sink.events()[0]?.metadata.adapterKey, "codex")``

- **KEEP** ``R5 #17: no adapter in context leaves adapterKey absent`` (baseline line 1204). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(sink.events()[0]?.metadata.adapterKey, undefined)``

- **KEEP** ``forgetting a deleted thread clears live work and drops buffered text before a later drain`` (baseline line 1211). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(liveness.liveAgentCount("t1"), 1)``; ``assert.equal(liveness.liveAgentCount("t1"), 0)``; ``assert.equal(sink.events().length, 0)``

- **KEEP** ``Q1 #9: a settled turn releases `projected`, so a later bare completion is inert`` (baseline line 1234). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(messageTexts(sink), [])``

- **KEEP** ``a malformed payload becomes a runtime.warning activity, not a throw`` (baseline line 1264). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(rows.length, 1)``

- **KEEP** ``an event with no thread id is logged and dropped, never thrown`` (baseline line 1279). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(sink.events().length, 0)``; ``assert.equal(warnings.length, 1)``

- **KEEP** ``a failing sink never escapes ingest`` (baseline line 1287). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.ok(warnings.length > 0)``

- **KEEP** ``a throwing liveness registry never escapes ingest`` (baseline line 1306). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.ok(warnings.length > 0)``; ``assert.equal(activityOfKind(sink, "task.started").length, 1, "the row is still written")``

- **DELETE** ``delivers domain events to the sink in the order they were produced`` (baseline line 1327). Sequentially awaited smoke sequence duplicates stronger named mandatory flush tests (request.opened before approval, tool start after reasoning close, settled turn after buffered text). It does not exercise sink concurrency.

- **REWRITE** ``drains a tool-output buffer at item completion, then releases its metadata`` (baseline line 1368). Keep the trailing tool-output flush regression; remove the unsupported private-map-release claim from its name/comment and assert output data directly. Original → surviving test: ``drains a tool-output buffer at item completion, then releases its metadata`` → ``flushes a trailing tool-output chunk at item completion`` in the same file; the surviving assertion requires the sole tool-output activity’s delta to equal ``"one line\n"``. No private memory inspection is retained.

  Oracle: ``assert.equal( sink.activities().filter((e) => e.payload.activity.activityKind === "tool.output").length, 0, "still buffered" )``; ``assert.equal(outputs.length, 1, "the trailing chunk is flushed, not discarded with the meta")``; ``assert.match(JSON.stringify(outputs[0]?.payload.activity.payload), /one line/)``

- **KEEP** ``a subagent's text and thinking never open, close or join the parent's segments`` (baseline line 1440). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(parentReasoning.length, 1, "the parent's thinking is ONE block, not two")``; ``assert.equal(parentReasoning[0]![1], "Parent thinking continues")``; ``assert.deepEqual( agentMessages.map(([, text]) => text).sort(), ["Agent says", "Agent thinking"], "the agent's two blocks are two rows, each carrying its own text" )``; ``assert.ok(rows.length >= 1)``; ``assert.ok( rows.every((row) => row.payload.agentId === "task-1"), "every row of an agent-owned message — delta, completion and close — carries the agentId" )``; ``assert.ok( rows.some((row) => !row.payload.streaming), "and each of them is closed" )``; ``assert.equal( [...texts.entries()].filter(([id, text]) => owners.get(id) === undefined && text === "Parent answer") .length, 1, "the parent's own answer is its own row" )``

- **KEEP** ``an agent-owned message never takes the id of a parent message of the same turn`` (baseline line 1531). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(parentIds.length, 1)``; ``assert.equal(agentIds.length, 1)``; ``assert.notEqual(parentIds[0], agentIds[0], "two owners, two messages")``

- **KEEP** ``a turn end closes an agent's open segment too`` (baseline line 1569). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(closes.length, 1, "no agent row is left streaming after its turn ended")``

- **KEEP** ```a turnless agent ${itemType} settles on its own item.completed``` (baseline line 1620). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual( sink.messages().map((event) => [ event.payload.messageId, event.payload.text, event.payload.streaming, event.payload.turnId, event.payload.agentId ]), [ [messageId, "Surveyed the packages", true, null, "task-1"], [messageId, "", false, null, "task-1"] ], "the block is written and closed, owned and turnless" )``; ``assert.equal(sink.messages().length, 2)``

- **KEEP** ``a turnless completion settles only the message its own deltas opened`` (baseline line 1650). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual( sink.messages().map((event) => [event.payload.messageId, event.payload.streaming]), [["assistant:agent:task-1:other", true]] )``

- **KEEP** ``a turnless owned command output is a turnless owned tool.output row (lock)`` (baseline line 1672). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(rest, [])``; ``assert.ok(row)``; ``assert.equal(row.payload.activity.turnId, null)``; ``assert.equal(row.payload.activity.agentId, "task-1")``; ``assert.deepEqual(row.payload.activity.payload, { toolUseId: "toolu_Y", streamKind: "command_output", delta: "a.txt\n" })``



## `apps/daemon/src/agent-host/ingestion/session-status.test.ts`

Independent source (B1): GUI design §§3.1 and 5.1 lifecycle table: failure versus user interrupt, dead process clears active turn, late thread identity preserves it, and resume cursor is not discarded.

Stable seam and refactor tolerance (B4–B5): nextSessionState runtime lifecycle -> persisted ThreadSessionState. No test-only implementation branch is required.

Non-test callers: createIngestion live lifecycle handling.

Lowest distinct owner / remaining stronger coverage (B6): Distinct transition inputs include stale errors and active-start identity updates not exercised by higher-level happy-path lifecycle cases.

Cases below name their recognizable failure; “oracle” records the original concrete expected output/state checks (B2–B3), inspected before editing. For REWRITE, the disposition explains which assertion/seam changes; the external contract remains the same.

- **KEEP** ``a failed turn leaves running for error, with the message`` (baseline line 12). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(next.status, "error")``; ``assert.equal(next.lastError, "context overflow")``

- **KEEP** ``an interrupted turn leaves no lastError on the head`` (baseline line 25). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(next.lastError, undefined)``

- **KEEP** ``session.exited always clears the active turn`` (baseline line 33). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(next, { status: "stopped", activeTurnId: null, lastError: "exit 1" })``

- **KEEP** ``a graceful exit carries no error`` (baseline line 41). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(next.lastError, undefined)``

- **KEEP** ``thread.started during an active turn preserves running and records the provider id`` (baseline line 49). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(next.status, "running")``; ``assert.equal(next.activeTurnId, "turn-1")``; ``assert.equal(next.providerThreadId, "prov-1")``

- **KEEP** ``a session state that cannot hold a turn drops the active turn`` (baseline line 59). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(next.activeTurnId, null)``

- **KEEP** ``session.started keeps the resume cursor the adapter reported`` (baseline line 67). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(next.resumeCursor, { cursor: 7 })``



## `apps/daemon/src/agent-host/ingestion/text-boundary.test.ts`

Independent source (B1): GUI design §5.6 never split a code block, using CommonMark fence/list/blank-line syntax.

Stable seam and refactor tolerance (B4–B5): splitBufferedText text splitting grammar. No test-only implementation branch is required.

Non-test callers: DeltaBufferSet flush boundaries.

Lowest distinct owner / remaining stronger coverage (B6): These four Markdown edge inputs are absent from generic batching tests; parser seam avoids any timer/private-map assertions.

Cases below name their recognizable failure; “oracle” records the original concrete expected output/state checks (B2–B3), inspected before editing. For REWRITE, the disposition explains which assertion/seam changes; the external contract remains the same.

- **KEEP** ``a fence indented past a list marker still opens and closes`` (baseline line 8). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(split.openFence, false)``; ``assert.ok(split.ready.endsWith(" ` ``\n"))``

- **KEEP** ``a closing fence with an info string does not close the block`` (baseline line 14). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(split.openFence, true)``

- **KEEP** ``a tight list breaks on each item start, including the partial last line`` (baseline line 19). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(split.ready, "intro\n- one\n")``; ``assert.equal(split.rest, "- two")``

- **KEEP** ``a no-break space is paragraph content, not a blank line`` (baseline line 25). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(split.ready, "")``; ``assert.equal(split.rest, "one\n \ntwo\n")``



## `apps/daemon/src/agent-host/main.test.ts`

Independent source (B1): GUI design §5.1 attachment cleanup and host boot requirements: uploads abandoned before restart must not survive forever when restarts are shorter than the sweep interval.

Stable seam and refactor tolerance (B4–B5): Real isolated startAgentHost boot and filesystem artifact removal, preserving a fresh upload. No test-only implementation branch is required.

Non-test callers: Daemon host process entry.

Lowest distinct owner / remaining stronger coverage (B6): Store sweep tests cannot prove boot invokes the sweep; test observes real files and waits on filesystem notification. Composition integration, not browser E2E.

Cases below name their recognizable failure; “oracle” records the original concrete expected output/state checks (B2–B3), inspected before editing. For REWRITE, the disposition explains which assertion/seam changes; the external contract remains the same.

- **KEEP** ``sweeps once at boot, so a restart collects what accumulated while it was down`` (baseline line 31). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal((await readdir(pendingDir)).includes("attachment-1-abcdef.part"), false)``; ``assert.ok(await stat(fresh), "an upload still in flight is not collected")``



## `apps/daemon/src/agent-host/server/http-server.test.ts`

Independent source (B1): GUI design §§3.1, 6.2–6.6; lazy-boot/index design C; agent-profile §4.8; goals §5.7: authenticated host HTTP routes, error/status vocabulary, stream framing, byte windows, prompt/index readiness and handover commands.

Stable seam and refactor tolerance (B4–B5): Real HTTP requests through a throwaway Unix socket; actual orchestrator/index for route behavior. No test-only implementation branch is required.

Non-test callers: AgentHostClient/daemon supervisor and chat/workflow/MCP proxy callers.

Lowest distinct owner / remaining stronger coverage (B6): Retain transport serialization/status/routing contracts absent from direct service tests. Real index cases distinguish retryable unreadable/behind from authoritative absent results. These are socket integrations, not browser E2E.

Cases below name their recognizable failure; “oracle” records the original concrete expected output/state checks (B2–B3), inspected before editing. For REWRITE, the disposition explains which assertion/seam changes; the external contract remains the same.

- **KEEP** ``answers one identical 401 for a missing and for a wrong token`` (baseline line 194). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(missing.status, 401)``; ``assert.deepEqual(wrong, missing)``; ``assert.equal((wrong.body as { error: { code: string } }).error.code, "COMMAND_REJECTED")``

- **KEEP** ``health reports the protocol version and host identity`` (baseline line 220). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(result.status, 200)``; ``assert.equal(body.ok, true)``; ``assert.equal(body.protocolVersion, 1)``; ``assert.equal(body.hostInstanceId, "host-test")``; ``assert.equal(body.pid, 4242)``

- **KEEP** ``reports live and active-turn threads for the drain-restart`` (baseline line 232). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(body.liveThreadIds, [threadId])``; ``assert.deepEqual(body.activeTurnThreadIds, [threadId])``; ``assert.deepEqual( body.backgroundWorkThreadIds, [], "the drain-restart also waits on live background work (§3.1)" )``

- **KEEP** ``routes every §6.2 command and answers `{seq}``` (baseline line 250). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(turn.status, 200)``; ``assert.equal(typeof (turn.body as { seq: number }).seq, "number")``; ``assert.equal(interrupt.status, 200)``; ``assert.equal(mode.status, 200)``; ``assert.equal(stop.status, 200)``

- **KEEP** ``maps every rejection to its §6.2 status`` (baseline line 281). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(invalid.status, 400)``; ``assert.equal((invalid.body as { error: { code: string } }).error.code, "INVALID_COMMAND")``; ``assert.equal(missing.status, 404)``; ``assert.equal((missing.body as { error: { code: string } }).error.code, "THREAD_NOT_FOUND")``; ``assert.equal(conflict.status, 409)``; ``assert.equal( (conflict.body as { error: { code: string } }).error.code, "COMMAND_ID_CONFLICT" )``

- **KEEP** ``creates, renames and deletes a thread`` (baseline line 314). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(created.status, 200)``; ``assert.equal((created.body as { title: string }).title, "First")``; ``assert.equal(renamed.status, 200)``; ``assert.equal((read.body as { kind: string }).kind, "snapshot")``; ``assert.equal( (read.body as { thread: { head: { title: string } } }).thread.head.title, "Renamed" )``; ``assert.equal(deleted.status, 200)``; ``assert.deepEqual(h.host.checkpoints.deleted, ["thread-x"])``; ``assert.equal(gone.status, 404)``

- **KEEP** ``404s an unknown item and an unknown turn diff`` (baseline line 349). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal((await h.call("GET", agentHostRoutes.item(threadId, "nope"))).status, 404)``; ``assert.equal((await h.call("GET", agentHostRoutes.turnDiff(threadId, 7))).status, 404)``

- **KEEP** ``serves a tool call's streamed output joined from the log, and 404s with its own code`` (baseline line 357). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(running.status, 200)``; ``assert.deepEqual(running.body, { toolUseId: shell, output: "one\n two\n", complete: false, truncated: false })``; ``assert.equal(missing.status, 404, itemId)``; ``assert.equal((missing.body as { error: { code: string } }).error.code, "ITEM_NOT_FOUND", itemId)``; ``assert.equal(miss.status, 404)``; ``assert.equal((miss.body as { error: { code: string } }).error.code, "THREAD_NOT_FOUND")``; ``assert.equal(gone.status, 404)``; ``assert.equal((gone.body as { error: { code: string } }).error.code, "THREAD_NOT_FOUND")``

- **KEEP** ``answers one window of the join when offset or maxBytes asks for it, and the whole join without either`` (baseline line 428). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(first.status, 200)``; ``assert.deepEqual(first.body, { toolUseId: "bgshell:task-1", offset: 0, text: "one\n", totalBytes: 10, nextOffset: 4, complete: false, truncated: false })``; ``assert.equal(text, "one\n two\n")``; ``assert.deepEqual((await output("?maxBytes=3")).body, { toolUseId: "bgshell:task-1", offset: 0, text: "one", totalBytes: 10, nextOffset: 3, complete: false, truncated: false })``; ``assert.deepEqual((await output("?offset=4")).body, { toolUseId: "bgshell:task-1", offset: 4, text: " two\n", totalBytes: 10, complete: false, truncated: false })``; ``assert.deepEqual((await output("")).body, { toolUseId: "bgshell:task-1", output: "one\n two\n", complete: false, truncated: false })``

- **KEEP** ``refuses a malformed offset, clamps maxBytes, and answers an offset past the end as the end`` (baseline line 451). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(refused.status, 400, offset)``; ``assert.equal((refused.body as { error: { code: string } }).error.code, "INVALID_COMMAND", offset)``; ``assert.equal(twice.status, 400)``; ``assert.equal((twice.body as { error: { code: string } }).error.code, "INVALID_COMMAND")``; ``assert.equal(((await output("?offset=0&maxBytes=3&maxBytes=100")).body as { text: string }).text, "one")``; ``assert.deepEqual([(await output("?offset=0&maxBytes=0")).body], [{ toolUseId: "bgshell:task-1", offset: 0, text: "o", totalBytes: 10, nextOffset: 1, complete: false, truncated: false }])``; ``assert.equal(((await output(`?offset=0&maxBytes=${maxBytes}`)).body as { text: string }).text, "one\n two\n", maxBytes)``; ``assert.equal(end.status, 200, offset)``; ``assert.deepEqual(end.body, { toolUseId: "bgshell:task-1", offset: 10, text: "", totalBytes: 10, complete: false, truncated: false }, offset)``; ``assert.equal(missing.status, 404, itemId)``; ``assert.equal((missing.body as { error: { code: string } }).error.code, "ITEM_NOT_FOUND", itemId)``; ``assert.equal(gone.status, 404)``; ``assert.equal((gone.body as { error: { code: string } }).error.code, "THREAD_NOT_FOUND")``

- **KEEP** ``serves the provider snapshots with the host instance id`` (baseline line 489). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(result.status, 200)``; ``assert.deepEqual(result.body, { providers: [], hostInstanceId: "host-test" })``; ``assert.equal( (await h.call("POST", agentHostRoutes.providerRefresh("nope"))).status, 404 )``

- **KEEP** ``claims an attachment from a raw octet-stream body and resolves it back`` (baseline line 501). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(uploaded.status, 200)``; ``assert.equal(ref.name, "notes.md")``; ``assert.equal(resolved.status, 200)``; ``assert.equal(typeof (resolved.body as { path: string }).path, "string")``; ``assert.equal(ref.path, (resolved.body as { path: string }).path, "the upload reply names the same absolute path the resolve route does")``; ``assert.equal( (await h.call("GET", agentHostExtraRoutes.attachment(threadId, "nope"))).status, 404 )``

- **KEEP** ``serves the §6.4 summary fields the daemon cannot derive from the log`` (baseline line 549). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(summary.status, 200)``; ``assert.equal(body.chatSessionStatus, "running")``; ``assert.equal(body.backgroundLiveness, null)``; ``assert.deepEqual(body.pendingRequests, [])``

- **KEEP** ``names every open request so the daemon can publish agentChat.pending`` (baseline line 563). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(body.hasPendingApprovals, true)``; ``assert.deepEqual(body.pendingRequests.map(({ requestId, kind }) => ({ requestId, kind })), [ { requestId: "req-7", kind: "approval" } ])``

- **KEEP** ``answers an unknown route with 404 rather than hanging`` (baseline line 602). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal((await h.call("GET", "/nope")).status, 404)``; ``assert.equal((await h.call("POST", "/threads/thread-1/unknown", {})).status, 404)``

- **KEEP** ``opens with a snapshot, marks synchronized, then streams live events`` (baseline line 611). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(live.frames[0]?.kind, "snapshot")``; ``assert.ok(synchronizedIndex < messageIndex, "live frames follow the marker")``

- **KEEP** ``replays by cursor when the range is small enough`` (baseline line 634). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(live.frames[0]?.kind, "event", "a small range replays instead of snapshotting")``

- **KEEP** ``two clients converge on the same order (§6.6)`` (baseline line 647). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(seen(a.frames), seen(b.frames))``; ``assert.deepEqual( seen(a.frames), [...seen(a.frames)].sort((left, right) => left - right) )``

- **KEEP** ``closes every open stream when the host stops`` (baseline line 674). **B1:** the public server close contract and GUI design §§3.1/6.3 require graceful host shutdown to release its long-lived event streams. **B2:** an existing client left connected prevents the case completing within its 10-second test deadline, exposing a shutdown hang. **B3:** the expected externally observed response closure is independent of the server's stream registry and close implementation. **B4–B5:** a real Unix-socket HTTP response is first proven live by its `synchronized` frame; the test then invokes the public `server.close()` and observes the client's response `close` event, without examining private call topology. **B6:** `stream.test.ts` owns individual stream state with response doubles; only this server integration catches omission of active HTTP connections from host shutdown. Other server cases explicitly close their own clients first.

  Oracle: after `live.waitFor` observes a real `synchronized` frame, both `await h.server.close()` and `await live.closed` must resolve before the enclosing 10-second timeout. `live.closed` is resolved only by `response.once("close", done)` in the real HTTP client; this test never calls the client-side `live.close()` helper. This is a positive event/deadline assertion, not an assertion-free coverage probe: leaving the established response open fails the test.

- **KEEP** ``is a 409 COMMAND_REJECTED once the host is up, never a 500`` (baseline line 722). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(answer.status, 409)``; ``assert.equal(envelope.error.code, "COMMAND_REJECTED")``; ``assert.match(envelope.error.message, /timed out/)``

- **KEEP** ``is a 503 HOST_UNAVAILABLE while the host is still cold`` (baseline line 738). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(answer.status, 503)``; ``assert.equal((answer.body as { error: { code: string } }).error.code, "HOST_UNAVAILABLE")``

- **KEEP** ``answers 503 INDEX_UNAVAILABLE for history without a usable index, 404 for no thread`` (baseline line 768). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(answer.status, 503)``; ``assert.equal( (answer.body as { error: { code: string } }).error.code, "INDEX_UNAVAILABLE" )``; ``assert.equal(missing.status, 404)``

- **KEEP** ``stamps the snapshot a thread read answers with its history bounds`` (baseline line 784). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(read.status, 200)``; ``assert.deepEqual(thread.history, { indexed: true, hasOlder: false, beforeCursor: null, oldestRetainedOrdinal: null, totalTurns: 0 })``

- **KEEP** ``caps the search query by code point and answers blank queries`` (baseline line 803). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal( Array.from((clamped.body as ThreadSearchResponse).query).length, 200 )``; ``assert.equal(blank.status, 200)``; ``assert.deepEqual(blank.body, { query: "", hits: [], truncated: false, indexed: true })``

- **KEEP** ``answers search `indexed: false` with a 200 when there is no usable index`` (baseline line 824). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(answer.status, 200)``; ``assert.deepEqual(answer.body, { query: "anything", hits: [], truncated: false, indexed: false })``

- **KEEP** ``lists the thread's prompts from the index, newest first — steers included`` (baseline line 904). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(answer.status, 200)``; ``assert.equal(body.threadId, threadId)``; ``assert.equal(body.indexed, true)``; ``assert.equal(body.before, null)``; ``assert.deepEqual( body.prompts.map((entry) => [entry.text, entry.turnId, entry.turnOrdinal, entry.rewindable]), [ ["a steer", "turn-2", null, null], ["second prompt", "turn-2", 2, true], ["first prompt", "turn-1", 1, true] ] )``; ``assert.ok(body.prompts.every((entry) => !entry.truncated && entry.seq > 0))``; ``assert.deepEqual(first.prompts.map((entry) => entry.text), ["a steer", "second prompt"])``; ``assert.notEqual(first.before, null)``; ``assert.deepEqual( (rest.body as ThreadPromptsResponse).prompts.map((entry) => entry.text), ["first prompt"] )``; ``assert.equal((rest.body as ThreadPromptsResponse).before, null)``

- **KEEP** ``answers the list `indexed: false` without a usable index, the text 503, and 404 for no thread`` (baseline line 957). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(list.status, 200)``; ``assert.deepEqual(list.body, { threadId, prompts: [], before: null, indexed: false } satisfies ThreadPromptsResponse)``; ``assert.equal(text.status, 503)``; ``assert.equal((text.body as { error: { code: string } }).error.code, "INDEX_UNAVAILABLE")``; ``assert.equal(missing.status, 404, path)``; ``assert.equal((missing.body as { error: { code: string } }).error.code, "THREAD_NOT_FOUND")``

- **KEEP** ``serves one prompt's whole text, and 404 PROMPT_NOT_FOUND for any other id`` (baseline line 988). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.ok(entry !== undefined && entry.messageId.includes(":"), "an id the path must encode")``; ``assert.equal(answer.status, 200)``; ``assert.deepEqual(answer.body, { messageId: entry.messageId, text: "look at this", truncated: false } satisfies ThreadPromptTextResponse)``; ``assert.equal(missing.status, 404, messageId)``; ``assert.equal( (missing.body as { error: { code: string } }).error.code, "PROMPT_NOT_FOUND", messageId )``

- **KEEP** ``answers `catchingUp` while the index catches up with a thread, the page once it has, and `indexed:false` for one it never will`` (baseline line 1028). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(catching.status, 200)``; ``assert.deepEqual(catching.body, { threadId, prompts: [], before: null, indexed: false, catchingUp: true } satisfies ThreadPromptsResponse)``; ``assert.equal(text.status, 503, "no 404 from an index that cannot say yet")``; ``assert.equal((text.body as { error: { code: string } }).error.code, "INDEX_UNAVAILABLE")``; ``assert.equal(caughtUp.indexed, true)``; ``assert.equal(caughtUp.catchingUp, undefined)``; ``assert.deepEqual(caughtUp.prompts.map((entry) => entry.text), ["first prompt"])``; ``assert.equal(whole.status, 200)``; ``assert.equal(absent.status, 404, "caught up: now a missing prompt is a 404")``; ``assert.deepEqual(behind.body, { threadId: unreached, prompts: [], before: null, indexed: false } satisfies ThreadPromptsResponse)``; ``assert.equal((await h.call("GET", agentHostRoutes.promptText(unreached, "user:2"))).status, 503)``

- **KEEP** ``answers a read that failed with a retryable 503 INDEX_UNAVAILABLE, never an empty page`` (baseline line 1091). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(answer.status, 503, path)``; ``assert.equal((answer.body as { error: { code: string } }).error.code, "INDEX_UNAVAILABLE", path)``

- **KEEP** ``reads a prompt longer than the index keeps back from its own line in the log`` (baseline line 1118). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(longEntry.text.length, 4000)``; ``assert.equal(longEntry.truncated, true)``; ``assert.equal(whole.status, 200)``; ``assert.deepEqual(whole.body, { messageId: "user:long", text: long, truncated: false })``; ``assert.equal(clipped.messageId, "user:twice")``; ``assert.equal(clipped.truncated, true)``; ``assert.ok(clipped.text.length > 0 && clipped.text.length < twice.length)``; ``assert.ok(twice.startsWith(clipped.text))``; ``assert.equal(fallback.messageId, "user:long")``; ``assert.equal(fallback.truncated, true)``; ``assert.ok(fallback.text.length > 0 && fallback.text.length < long.length)``; ``assert.ok(long.startsWith(fallback.text))``

- **KEEP** ``POST /opencode/recycle-idle answers the OpenCode adapter's counts`` (baseline line 1167). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(answered.status, 200)``; ``assert.deepEqual(answered.body, { recycled: 2, deferred: 1 } satisfies AgentHostRecycleOpenCodeResponse)``; ``assert.equal(calls, 1)``; ``assert.equal((await h.call("GET", agentHostRoutes.recycleIdleOpenCode)).status, 404, "only POST is the route")``; ``assert.equal(calls, 1)``; ``assert.equal( (await h.call("POST", agentHostRoutes.recycleIdleOpenCode, undefined, "wrong-token")).status, 401, "behind the host's auth like every route" )``; ``assert.equal(calls, 1)``

- **KEEP** ``recycles nothing when no adapter serves OpenCode`` (baseline line 1194). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(answered.status, 200)``; ``assert.deepEqual(answered.body, { recycled: 0, deferred: 0 })``

- **KEEP** ``POST /goals/hold renews the lease and answers every thread held after it`` (baseline line 1207). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(nothing.status, 200)``; ``assert.deepEqual(nothing.body, { heldThreadIds: [] } satisfies AgentHostHoldGoalsResponse)``; ``assert.equal(held.status, 200)``; ``assert.deepEqual(held.body, { heldThreadIds: [threadId] })``; ``assert.equal(h.host.store.heads.get(threadId)?.goalHeldForHandover, true)``; ``assert.deepEqual(rows.map((row) => (row.payload as { heldForUpdate?: boolean }).heldForUpdate), [true])``; ``assert.deepEqual((await h.call("POST", agentHostRoutes.holdGoals)).body, { heldThreadIds: [threadId] })``; ``assert.equal((await h.call("GET", agentHostRoutes.holdGoals)).status, 404)``

- **KEEP** ``POST /goals/resume-sessions takes the threads it knows and refuses a malformed body whole`` (baseline line 1265). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(taken.status, 200)``; ``assert.deepEqual(taken.body, { threadIds: [threadId] } satisfies AgentHostResumeGoalSessionsResponse)``; ``assert.equal(refused.status, 400, JSON.stringify(body).slice(0, 60))``; ``assert.equal( (await h.call("GET", agentHostRoutes.resumeGoalSessions)).status, 404, "only POST is the route" )``



## `apps/daemon/src/agent-host/server/stream.test.ts`

Independent source (B1): GUI design §§5.6, 6.3, 6.6: lossless subscribe/read boundary, synchronized ordering, coalescing, heartbeat, bounded slow-client buffers and disconnect cleanup.

Stable seam and refactor tolerance (B4–B5): createThreadStream through Node ServerResponse write/drain/close protocol. No test-only implementation branch is required.

Non-test callers: HTTP thread event route.

Lowest distinct owner / remaining stronger coverage (B6): Response doubles implement socket backpressure only, never ordering/deduplication/budget policy. Deterministic in-flight races and drain are lower and stronger than ordinary HTTP happy paths.

Cases below name their recognizable failure; “oracle” records the original concrete expected output/state checks (B2–B3), inspected before editing. For REWRITE, the disposition explains which assertion/seam changes; the external contract remains the same.

- **KEEP** ``loses no event published while the read is in flight, and duplicates none`` (baseline line 138). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(frames[0]?.kind, "snapshot")``; ``assert.deepEqual( frames.slice(1, -1).map((frame) => (frame as { seq: number }).seq), [6] )``; ``assert.equal(frames.at(-1)?.kind, "synchronized")``; ``assert.equal( (frames.at(-1) as { hostInstanceId: string }).hostInstanceId, "host-1", "a restarted host is not a reconnect (§8)" )``

- **KEEP** ``pushes `synchronized` after everything buffered, never straight to the socket`` (baseline line 187). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual( frames.map((frame) => ("seq" in frame ? frame.seq : frame.kind)), [1, 2, 3, "synchronized"] )``

- **KEEP** ``coalesces live tool updates on the 50 ms window and flushes on any other frame`` (baseline line 214). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(fake.lines.length, 0, "updates wait on the window")``; ``assert.deepEqual( parse(fake.lines).map((frame) => (frame as { seq: number }).seq), [11] )``; ``assert.deepEqual( parse(fake.lines).map((frame) => (frame as { seq: number }).seq), [12, 13], "a non-update frame flushes the run immediately" )``; ``assert.deepEqual(parse(fake.lines).map((frame) => (frame as { seq: number }).seq), [14, 15, 16, 17])``

- **KEEP** ``sends `:hb` on the heartbeat interval`` (baseline line 254). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(fake.lines.includes(":hb"), false)``; ``assert.equal(fake.lines.at(-1), ":hb")``; ``assert.equal(fake.lines.filter((line) => line === ":hb").length, 2)``

- **KEEP** ``closes the stream when the undrained write buffer passes its budget`` (baseline line 272). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(stream.closed, true)``; ``assert.deepEqual(closed, ["budget"])``; ``assert.equal(JSON.parse(fake.lines.at(-1) ?? "{}").kind, "error")``; ``assert.equal(fake.ended, true)``

- **KEEP** ``releases the charge once the socket drains`` (baseline line 300). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(stream.closed, false, "a client that keeps up is never cut")``

- **KEEP** ``stops writing once the client disconnects`` (baseline line 323). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(fake.lines.length, before)``; ``assert.deepEqual(closed, ["client"])``; ``assert.equal(fake.lines.length, before, "heartbeats stop after disconnect")``



## `apps/daemon/src/agent-host/support/code-stamp.test.ts`

Independent source (B1): Deploy drain-restart identity requirement (GUI design §3.1) and Git loose/packed/detached/worktree on-disk formats: launched code identity must match checkout without requiring git.

Stable seam and refactor tolerance (B4–B5): readCodeStamp over real throwaway filesystem layouts. No test-only implementation branch is required.

Non-test callers: main.ts health stamp and daemon supervisor adoption/drain logic.

Lowest distinct owner / remaining stronger coverage (B6): Supervisor tests own comparing identities, not reading Git formats. Distinct storage layouts and absent-repo fallback are needed.

Cases below name their recognizable failure; “oracle” records the original concrete expected output/state checks (B2–B3), inspected before editing. For REWRITE, the disposition explains which assertion/seam changes; the external contract remains the same.

- **KEEP** ``resolves a symbolic HEAD through a loose ref`` (baseline line 21). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(readCodeStamp(root), SHA_A)``; ``assert.equal(readCodeStamp(join(root, "apps", "daemon")), SHA_A)``

- **KEEP** ``falls back to packed-refs and reads a detached HEAD verbatim`` (baseline line 33). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(readCodeStamp(root), SHA_B)``; ``assert.equal(readCodeStamp(root), SHA_A)``

- **KEEP** ``follows a worktree's gitdir pointer and its commondir for refs`` (baseline line 47). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(readCodeStamp(wt), SHA_B)``

- **KEEP** ``is null outside a repository and never throws`` (baseline line 62). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(readCodeStamp(root), null)``; ``assert.equal(readCodeStamp(join(root, "missing")), null)``



## `apps/daemon/src/agent-host/support/deadline.test.ts`

Independent source (B1): GUI design §3.1 every provider wait is bounded and timed-out work is retired; Promise rejection and AbortSignal contracts.

Stable seam and refactor tolerance (B4–B5): withDeadline returned promise and timeout callback. No test-only implementation branch is required.

Non-test callers: Provider handshake/probe/cancel, host supervisor operations.

Lowest distinct owner / remaining stronger coverage (B6): These cases isolate winner/error/abort races; no single provider test covers utility-level late rejection or callback failure without replacing the timeout outcome.

Cases below name their recognizable failure; “oracle” records the original concrete expected output/state checks (B2–B3), inspected before editing. For REWRITE, the disposition explains which assertion/seam changes; the external contract remains the same.

- **KEEP** ``resolves the underlying value when it beats the deadline`` (baseline line 9). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(value, 7)``

- **KEEP** ``propagates the underlying rejection unchanged`` (baseline line 14). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.rejects( withDeadline(Promise.reject(boom), { label: "probe", timeoutMs: 1_000 }), (error: unknown) => error === boom )``

- **KEEP** ``expiry rejects with DeadlineExceededError and runs onTimeout`` (baseline line 22). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.rejects( withDeadline(new Promise<never>(() => {}), { label: "handshake", timeoutMs: 5, onTimeout: () => { killed = true; } }), (error: unknown) => { assert.ok(error instanceof DeadlineExceededError); assert.equal(error.label, "handshake"); assert.equal(error.timeoutMs, 5); return true; } )``; ``assert.ok(error instanceof DeadlineExceededError)``; ``assert.equal(error.label, "handshake")``; ``assert.equal(error.timeoutMs, 5)``; ``assert.equal(killed, true, "the child is killed rather than left starting forever")``

- **KEEP** ``a late rejection after expiry does not become an unhandled rejection`` (baseline line 42). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.rejects(withDeadline(work, { label: "cancel", timeoutMs: 5 }))``

- **KEEP** ``a failing onTimeout never replaces the deadline error`` (baseline line 53). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.rejects( withDeadline(new Promise<never>(() => {}), { label: "interrupt", timeoutMs: 5, onTimeout: () => { throw new Error("kill failed"); } }), DeadlineExceededError )``

- **KEEP** ``an abort signal wins, before and during the wait`` (baseline line 66). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.rejects( withDeadline(new Promise<never>(() => {}), { label: "x", timeoutMs: 1_000, signal: already }), /host stopping/ )``; ``assert.rejects(pending, /shutdown/)``



## `apps/daemon/src/agent-host/support/env.test.ts`

Independent source (B1): AGENTS.md daemon-secret boundary; GUI design §3.1 explicit launch environment, selected-account credentials and unshadowable session paths/launch marker.

Stable seam and refactor tolerance (B4–B5): buildProviderEnv returned child environment. No test-only implementation branch is required.

Non-test callers: main.ts adapter contexts and provider launch/probe paths.

Lowest distinct owner / remaining stronger coverage (B6): Configuration/security cases independently enumerate permitted bindings and denied ambient keys; real spawn tests own transmission, not environment construction.

Cases below name their recognizable failure; “oracle” records the original concrete expected output/state checks (B2–B3), inspected before editing. For REWRITE, the disposition explains which assertion/seam changes; the external contract remains the same.

- **KEEP** ``the env is built from nothing — process.env is never spread`` (baseline line 14). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(env.ORQ_ENV_LEAK_CANARY, undefined)``; ``assert.deepEqual(Object.keys(env).sort(), [ "HOME", "ORQUESTER_AGENT_LAUNCH", "ORQUESTER_SESSION_ID", "PATH", "TMPDIR" ])``

- **KEEP** ``every adapter binds its account home through its own variable`` (baseline line 31). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(env[variable], "/var/lib/orquester/daemon/agent-accounts/x/home")``; ``assert.equal(claude.HOME, base.homeDir)``; ``assert.equal(claude.CLAUDE_CONFIG_DIR, "/accounts/claude/home")``

- **KEEP** ``ambient vendor credentials are stripped from extraEnv`` (baseline line 50). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(env.XAI_API_KEY, undefined)``; ``assert.equal(env.GROK_OAUTH2_REFERRER, "https://x.ai")``; ``assert.equal(claude.ANTHROPIC_BASE_URL, "http://127.0.0.1:9")``; ``assert.equal(claude.ANTHROPIC_AUTH_TOKEN, undefined)``; ``assert.equal(claude.ANTHROPIC_API_KEY, undefined)``

- **KEEP** ``extraEnv can never move a child off the session PATH, TMPDIR or HOME`` (baseline line 72). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(env.PATH, base.sessionPath)``; ``assert.equal(env.TMPDIR, base.tmpDir)``; ``assert.equal(env.HOME, base.homeDir)``; ``assert.equal(env.OPENCODE_CONFIG_CONTENT, "{}")``

- **KEEP** ``the account binding wins over anything extraEnv sets`` (baseline line 84). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(env.CODEX_HOME, "/accounts/codex/home")``

- **KEEP** ``undefined values are dropped, never stringified`` (baseline line 94). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.ok(!("MAYBE" in env))``; ``assert.equal(env.REAL, "1")``

- **KEEP** ``every adapter's launch carries its own launch marker, which no launcher env shadows`` (baseline line 104). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(env["ORQUESTER_AGENT_LAUNCH"], `launch-of-${adapter}`, adapter)``

- **KEEP** ``ORQUESTER_SESSION_ID is always stamped`` (baseline line 116). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(env.ORQUESTER_SESSION_ID, "sess-1")``



## `apps/daemon/src/agent-host/support/leftover-processes.test.ts`

Independent source (B1): GUI design §3.1 and Grok fixtures observations 48/55: only marked recorded sessions are swept; never recycled PIDs/session leaders or daemonized/shared processes.

Stable seam and refactor tolerance (B4–B5): recordChildSessions/findLeftoverProcesses/stopLeftoverProcesses against kernel-shaped /proc and signals, plus real process tree. No test-only implementation branch is required.

Non-test callers: Grok session cleanup and leftover-work sweep; parseStat also serves workflows/sandbox/proc.ts.

Lowest distinct owner / remaining stronger coverage (B6): Mocks implement OS reads/signals only. Selection/starttime/double-read/fresh-scan safety is real production code; live-process integration cannot deterministically force PID reuse races.

Cases below name their recognizable failure; “oracle” records the original concrete expected output/state checks (B2–B3), inspected before editing. For REWRITE, the disposition explains which assertion/seam changes; the external contract remains the same.

- **KEEP** ``finds exactly the processes of a recorded session carrying this launch's marker`` (baseline line 23). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(found.map((entry) => [entry.pid, entry.starttime]), [[100, 10], [101, 11]])``

- **KEEP** ``a recycled session id is not ours: its live leader must be the process recorded`` (baseline line 37). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(await findLeftoverProcesses(LAUNCH, { sessions: [led(120, 10)] }), [])``

- **KEEP** ``a member whose leader is gone is still its session's`` (baseline line 45). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(found.map((entry) => entry.pid), [131])``

- **KEEP** ``a pid recycled while it was being read is not matched`` (baseline line 51). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(await findLeftoverProcesses(LAUNCH, { sessions: [led(200, 20)] }), [])``

- **KEEP** ``SIGTERM first; SIGKILL only for what outlived the grace, by a fresh scan of the same sessions`` (baseline line 59). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(proc.signals, [[300, "SIGTERM"], [301, "SIGTERM"]], "no early escalation")``; ``assert.deepEqual(await running, { found: 2, terminated: 2, killed: 2 })``; ``assert.deepEqual(proc.signals, [[300, "SIGTERM"], [301, "SIGTERM"], [301, "SIGKILL"], [303, "SIGKILL"]])``; ``assert.equal(proc.table.has(302), true)``

- **KEEP** ``the wait ends as soon as everything is gone — a zombie counts as gone`` (baseline line 82). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(result, { found: 2, terminated: 2, killed: 0 })``; ``assert.deepEqual(proc.signals, [[400, "SIGTERM"], [401, "SIGTERM"]])``

- **KEEP** ``a pid recycled before its signal is never signalled`` (baseline line 101). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(result, { found: 2, terminated: 1, killed: 0 })``; ``assert.ok(recycled !== undefined && proc.table.has(recycled))``; ``assert.equal(proc.signals.some(([pid]) => pid === recycled), false)``

- **KEEP** ``off Linux there is no /proc: nothing is read and nothing is signalled`` (baseline line 118). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(await stopLeftoverProcesses({ launchId: LAUNCH, sessions: [led(100, 10)] }), { found: 0, terminated: 0, killed: 0 })``; ``assert.deepEqual(await recordChildSessions(100), [])``; ``assert.deepEqual(proc.reads, [])``; ``assert.deepEqual(proc.signals, [])``

- **KEEP** ``an empty launch id matches nothing`` (baseline line 127). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(await findLeftoverProcesses("", { sessions: [led(600, 60)] }), [])``

- **KEEP** ``recordChildSessions: each child's own session, and the parent's for a child that shares it`` (baseline line 132). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual([...sessions].sort((a, b) => a.sid - b.sid), [led(700, 70), led(701, 71), led(702, 72)])``; ``assert.deepEqual(await recordChildSessions(799), [])``

- **KEEP** ``the real /proc: a recorded session's members are stopped, a daemon and a stranger spared`` (baseline line 183). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.ok( sessions.some((session) => session.sid === pids.get("shell")), "the shell's own session is recorded while its parent lives" )``; ``assert.equal(result.found, 3, "the shell and its two members")``; ``assert.equal(alive(pids.get("shell")!), false)``; ``assert.equal(alive(pids.get("polite")!), false, "SIGTERM stopped it")``; ``assert.equal(alive(pids.get("stubborn")!), false, "SIGKILL after the grace stopped the one ignoring SIGTERM")``; ``assert.equal(alive(pids.get("daemon")!), true, "a process that daemonized into a session of its own is spared")``; ``assert.equal(alive(stranger.pid!), true, "another launch's process is never touched")``



## `apps/daemon/src/agent-host/support/leftover-work.test.ts`

Independent source (B1): GUI design §3.1 durable leftover-work record and AGENTS.md storage/ownership/security: 0600, bounded launches/sessions, tolerant older/torn files, no resurrected deleted thread, concurrent records preserved.

Stable seam and refactor tolerance (B4–B5): Real filesystem readLeftoverWork/recordLeftoverWork/sweepLeftoverWork; malformed parser calls rewritten through stored bytes. No test-only implementation branch is required.

Non-test callers: Grok session recording and adapter sweepEndedSession.

Lowest distinct owner / remaining stronger coverage (B6): Persistence/concurrent-write/multilaunch sweep are unique here; individual-process selection remains in leftover-processes tests.

Cases below name their recognizable failure; “oracle” records the original concrete expected output/state checks (B2–B3), inspected before editing. For REWRITE, the disposition explains which assertion/seam changes; the external contract remains the same.

- **KEEP** ``a thread's leftover work is kept per launch, merged by launch, the newest launches only, 0600`` (baseline line 30). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(await readLeftoverWork(path), [ { launchId: "l1", recordedAt: "t2", sessions: [ { sid: 10, leaderStarttime: 100 }, { sid: 11, leaderStarttime: 110 } ] } ])``; ``assert.equal((await stat(path)).mode & 0o777, 0o600, "as sensitive as the thread dir it lives in")``; ``assert.equal(kept.length, 8, "the last few launches only")``; ``assert.equal(kept.at(-1)?.launchId, `l${8 + 2}`, "newest last")``; ``assert.equal(kept.some((launch) => launch.launchId === "l1"), false, "the oldest dropped first")``

- **KEEP** ``a launch keeps its newest sessions only`` (baseline line 66). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(launch?.sessions.length, 64)``; ``assert.equal(launch?.sessions.at(-1)?.sid, 64 + 11, "the newest sessions kept")``

- **REWRITE** ``a file that is not what this host writes reads as nothing, entry by entry`` (baseline line 75). Drive malformed/versioned/mixed persisted JSON through readLeftoverWork on a temp file; remove direct access to private parser and its export. Oracle remains valid session sid=5 plus rejection of invalid entries/version; torn file recovers on next record.

  Oracle: ``assert.deepEqual(parseLeftoverWork(null), [])``; ``assert.deepEqual(parseLeftoverWork("not json"), [])``; ``assert.deepEqual(parseLeftoverWork(JSON.stringify({ version: 99, launches: [] })), [])``; ``assert.deepEqual( parseLeftoverWork( JSON.stringify({ version: 1, launches: [ { launchId: "", recordedAt: "t", sessions: [] }, { launchId: "ok", recordedAt: "t", sessions: [{ sid: 5, leaderStarttime: 1 }, { sid: "x" }, { sid: 1, leaderStarttime: 2 }] }, "junk" ] }) ), [{ launchId: "ok", recordedAt: "t", sessions: [{ sid: 5, leaderStarttime: 1 }] }], "a session id is a pid above 1, a launch names itself" )``; ``assert.deepEqual(await readLeftoverWork(path), [])``; ``assert.equal((await readLeftoverWork(path)).length, 1, "and is replaced by the next record")``

- **KEEP** ``a record never recreates a thread directory that is gone — no ghost thread at the next boot`` (baseline line 100). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(existsSync(threadDir), false, "the store deleted the thread: a late record writes nothing")``; ``assert.deepEqual(await readLeftoverWork(path), [])``

- **KEEP** ``concurrent records of one thread are serialised: none is lost`` (baseline line 109). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal((await readLeftoverWork(path)).length, 6)``

- **KEEP** ``the sweep stops each launch's work by its own marker and sessions — nothing else — then forgets it`` (baseline line 123). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(proc.signals.map(([pid]) => pid).sort((a, b) => a - b), [200, 201, 300])``; ``assert.deepEqual(result, { found: 3, terminated: 3, killed: 0 })``; ``assert.equal(proc.table.has(250) && proc.table.has(202), true)``; ``assert.deepEqual(await readLeftoverWork(path), [])``; ``assert.rejects(readFile(path, "utf8"), { code: "ENOENT" })``

- **KEEP** ``a close sweeps every remembered launch at once: one grace window, not one per launch`` (baseline line 143). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(proc.signals.filter(([, signal]) => signal === "SIGTERM").length, launches)``; ``assert.deepEqual(await running, { found: launches, terminated: launches, killed: launches })``; ``assert.equal(proc.table.size, 0)``

- **KEEP** ``a thread with nothing remembered sweeps nothing, and off Linux nothing is read`` (baseline line 170). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(await sweepLeftoverWork(path), { found: 0, terminated: 0, killed: 0 })``; ``assert.deepEqual(await sweepLeftoverWork(path), { found: 0, terminated: 0, killed: 0 })``; ``assert.deepEqual(proc.reads, [])``; ``assert.deepEqual(proc.signals, [])``



## `apps/daemon/src/agent-host/support/ndjson.test.ts`

Independent source (B1): Provider NDJSON/UTF-8 framing and GUI design §3.1 bounded transport memory: chunks may split lines/code points; BOM/CRLF; comments; ordered drain; overflow must not grow memory without limit.

Stable seam and refactor tolerance (B4–B5): NdjsonLineReader/parseNdjsonLine/NdjsonWriter input/output bytes and Node drain seam. No test-only implementation branch is required.

Non-test callers: Codex/Grok protocol transports and host consumers.

Lowest distinct owner / remaining stronger coverage (B6): Parser split boundaries and writer budget/serialization failure are lowest transport seams; protocol suites own RPC semantics, not arbitrary byte partitions.

Cases below name their recognizable failure; “oracle” records the original concrete expected output/state checks (B2–B3), inspected before editing. For REWRITE, the disposition explains which assertion/seam changes; the external contract remains the same.

- **KEEP** ``line reader carries a remainder across chunk boundaries`` (baseline line 7). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(reader.push('{"a":'), [])``; ``assert.deepEqual(reader.push('1}\n{"b":2}\n'), ['{"a":1}', '{"b":2}'])``; ``assert.deepEqual(reader.flush(), [])``

- **KEEP** ``line reader strips CRLF and never emits a phantom blank line on a split CRLF`` (baseline line 14). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(reader.push("one\r"), [])``; ``assert.deepEqual(reader.push("\ntwo\r\n"), ["one", "two"])``; ``assert.deepEqual(reader.flush(), [])``

- **KEEP** ``line reader strips a leading BOM exactly once`` (baseline line 22). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(reader.push(' {"a":1}\n tail\n'), ['{"a":1}', " tail"])``

- **KEEP** ``line reader flushes an unterminated final line`` (baseline line 27). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(reader.push("a\nb"), ["a"])``; ``assert.deepEqual(reader.flush(), ["b"])``; ``assert.deepEqual(reader.flush(), [])``

- **KEEP** ``line reader decodes a multi-byte codepoint split across chunks`` (baseline line 34). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(reader.push(bytes.subarray(0, 1)), [])``; ``assert.deepEqual(reader.push(bytes.subarray(1)), ["é"])``

- **REWRITE** ``line reader discards an overlong partial line until the next newline`` (baseline line 41). Use an independent literal 8 MiB input boundary, removing the expectation derived from production NDJSON_MAX_LINE_BYTES; internalize the otherwise test-only constant export.

  Oracle: ``assert.deepEqual(reader.push(chunk), [])``; ``assert.deepEqual(reader.push(chunk), [])``; ``assert.deepEqual(reader.push("tail\nnext\n"), ["next"])``; ``assert.deepEqual(reader.flush(), [])``

- **KEEP** ``parseNdjsonLine skips blanks and comments`` (baseline line 50). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(parseNdjsonLine(""), undefined)``; ``assert.equal(parseNdjsonLine(" "), undefined)``; ``assert.equal(parseNdjsonLine(":hb"), undefined)``; ``assert.deepEqual(parseNdjsonLine(' {"a":1} '), { a: 1 })``

- **KEEP** ``writer queues behind backpressure and flushes in order on drain`` (baseline line 73). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(sink.written, ['{"n":1}\n'])``; ``assert.deepEqual(sink.written, ['{"n":1}\n', '{"n":2}\n', '{"n":3}\n'])``

- **KEEP** ``writer drops rather than growing past the queue budget`` (baseline line 88). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(writer.write({ padding: "x".repeat(3 * 1024 * 1024) }), true)``; ``assert.equal(writer.write({ padding: "x".repeat(3 * 1024 * 1024) }), false, "second queued record drops")``

- **KEEP** ``writer survives a non-serialisable record without taking the stream down`` (baseline line 99). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(writer.write(cyclic), false)``; ``assert.equal(writer.write({ ok: true }), true)``; ``assert.deepEqual(sink.written, ['{"ok":true}\n'])``

- **KEEP** ``writer appends the newline only when missing, and stops after close`` (baseline line 110). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(sink.written, ['{"a":1}\n', '{"b":2}\n'])``



## `apps/daemon/src/agent-host/support/spawn-group.test.ts`

Independent source (B1): GUI design §3.1 whole-process-group kill; concrete leaked MCP-grandchild regression E20.

Stable seam and refactor tolerance (B4–B5): Real spawnProviderChild child/grandchild process group and observed exit. No test-only implementation branch is required.

Non-test callers: Every provider child spawner.

Lowest distinct owner / remaining stronger coverage (B6): Distinct POSIX descendant-kill regression; single-child spawn test cannot catch orphaned descendants.

Cases below name their recognizable failure; “oracle” records the original concrete expected output/state checks (B2–B3), inspected before editing. For REWRITE, the disposition explains which assertion/seam changes; the external contract remains the same.

- **KEEP** ``a grandchild dies with the provider child`` (baseline line 49). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.ok(Number.isFinite(grandchild) && grandchild > 0)``; ``assert.equal(isAlive(grandchild), true, "the grandchild is up before the kill")``



## `apps/daemon/src/agent-host/support/spawn.test.ts`

Independent source (B1): GUI design §3.1 process outcome, explicit environment, stderr availability, bounded TERM/KILL, idempotent stop and host-initiated graceful exit.

Stable seam and refactor tolerance (B4–B5): spawnProviderChild with real Node processes and exitOutcome semantic result. No test-only implementation branch is required.

Non-test callers: Codex/OpenCode/Grok children and Claude probes.

Lowest distinct owner / remaining stronger coverage (B6): These isolate launch/pipe/exit failure classes; host teardown owns composition ordering and cannot substitute for per-child environment/exit-path cases.

Cases below name their recognizable failure; “oracle” records the original concrete expected output/state checks (B2–B3), inspected before editing. For REWRITE, the disposition explains which assertion/seam changes; the external contract remains the same.

- **KEEP** ``records the pid and resolves with the exit code`` (baseline line 18). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(typeof proc.pid, "number")``; ``assert.ok((proc.pid ?? 0) > 0)``; ``assert.deepEqual(reason, { kind: "exit", code: 3, signal: null })``; ``assert.equal(proc.hasExited(), true)``; ``assert.deepEqual(proc.exitReason(), reason)``

- **KEEP** ``the environment is exactly what was passed — nothing is inherited`` (baseline line 28). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(keys, ["ORQUESTER_SESSION_ID", "PATH"])``

- **KEEP** ``stderr is piped, not discarded`` (baseline line 47). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(Buffer.concat(chunks).toString("utf8"), "boom\n")``

- **KEEP** ``a spawn failure is an outcome, never a throw`` (baseline line 55). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(reason.kind, "spawn-error")``

- **KEEP** ``kill escalates SIGTERM to SIGKILL past the grace deadline`` (baseline line 66). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(reason.kind, "signal")``; ``assert.equal(reason.signal, "SIGKILL")``

- **KEEP** ``kill is idempotent and safe after the child is already gone`` (baseline line 79). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(a, b)``; ``assert.deepEqual(a, { kind: "exit", code: 0, signal: null })``

- **KEEP** ``exitOutcome follows the §3.1 rule`` (baseline line 88). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(exitOutcome(zero, false).status, "stopped")``; ``assert.equal(exitOutcome(zero, false).exitKind, "graceful")``; ``assert.equal(exitOutcome(nonZero, false).status, "error")``; ``assert.equal(exitOutcome(nonZero, false).exitKind, "error")``; ``assert.equal(exitOutcome(nonZero, true).exitKind, "graceful")``; ``assert.equal(exitOutcome(nonZero, true).status, "stopped")``



## `apps/daemon/src/agent-host/support/stderr.test.ts`

Independent source (B1): AGENTS.md never leak secrets; GUI design §3.1 stderr redaction/classification and 4 KiB tail; Grok fixture encoded-home observation.

Stable seam and refactor tolerance (B4–B5): redactStderr/classifyStderrLine/StderrCapture text and excerpt outputs. No test-only implementation branch is required.

Non-test callers: Provider sessions/probes, profile CLI runner and server error redaction.

Lowest distinct owner / remaining stronger coverage (B6): Security transformations, classification and chunk/tail boundaries each fail on distinct inputs; fixture scan checks recorded bytes, not runtime sanitizer correctness.

Cases below name their recognizable failure; “oracle” records the original concrete expected output/state checks (B2–B3), inspected before editing. For REWRITE, the disposition explains which assertion/seam changes; the external contract remains the same.

- **KEEP** ``stripAnsi removes colour, cursor and OSC sequences`` (baseline line 10). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(classifyStderrLine("\u001b[31mred\u001b[0m").text, "red")``; ``assert.equal(classifyStderrLine("\u001b[2K\u001b[1Gline").text, "line")``; ``assert.equal(classifyStderrLine("\u001b]0;title\u0007body").text, "body")``; ``assert.equal(classifyStderrLine("plain").text, "plain")``

- **KEEP** ``redaction collapses home paths, longest first`` (baseline line 17). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(out, "read ~/creds")``

- **KEEP** ``redaction collapses a percent-encoded home too, in either hex case`` (baseline line 24). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(out, "tail ~/.grok/sessions/~%2Fwork/a.log and ~%2fwork")``; ``assert.equal(redactStderr("x %2Fa.b%2Fc", { homeDirs: ["/a.b"] }), "x ~%2Fc")``; ``assert.equal(redactStderr("x %2FaXb%2Fc", { homeDirs: ["/a.b"] }), "x %2FaXb%2Fc")``

- **KEEP** ``redaction masks auth headers, bearer values and token shapes`` (baseline line 38). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal( redactStderr("Authorization: Bearer abc.def-ghi"), "Authorization: [redacted]" )``; ``assert.equal(redactStderr("x-api-key=supersecretvalue"), "x-api-key=[redacted]")``; ``assert.equal( redactStderr("used sk-abcdefghijklmnop and ghp_ABCDEFGHIJKLMNOPQR"), "used [redacted] and [redacted]" )``; ``assert.equal(redactStderr("token xoxb-1234567890ab"), "token [redacted]")``; ``assert.equal(redactStderr("the sk- prefix"), "the sk- prefix")``

- **KEEP** ``classification: benign snippets and sub-ERROR levels drop`` (baseline line 53). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(classifyStderrLine("").class, "drop")``; ``assert.equal( classifyStderrLine("WARN state db missing rollout path for thread abc").class, "drop" )``; ``assert.equal(classifyStderrLine("2026-09-21 INFO started listener").class, "drop")``; ``assert.equal(classifyStderrLine("DEBUG handshake ok").class, "drop")``

- **KEEP** ``classification: fatal snippets become errors, everything else a warning`` (baseline line 63). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(classifyStderrLine("codex: command not found").class, "error")``; ``assert.equal(classifyStderrLine("Error: ENOENT no such file or directory").class, "error")``; ``assert.equal(classifyStderrLine("You are not logged in").class, "error")``; ``assert.equal(classifyStderrLine("something unusual happened").class, "warning")``; ``assert.equal(classifyStderrLine("2026-09-21 ERROR provider.stream reset").class, "warning")``

- **KEEP** ``classification redacts before it classifies, so the text is always safe`` (baseline line 72). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(line.class, "error")``; ``assert.equal(line.text, "fatal error: key [redacted]")``

- **KEEP** ``capture splits lines with a remainder and flushes the tail`` (baseline line 78). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(capture.push("one unusual\ntwo unu").map((l) => l.text), ["one unusual"])``; ``assert.deepEqual(capture.push("sual\n").map((l) => l.text), ["two unusual"])``; ``assert.deepEqual(capture.push("trailing"), [])``; ``assert.deepEqual(capture.flush().map((l) => l.text), ["trailing"])``; ``assert.deepEqual(capture.flush(), [])``

- **KEEP** ``capture keeps a redacted, bounded tail`` (baseline line 87). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(capture.excerpt(), "opening ~/creds with [redacted]\n")``; ``assert.ok(Buffer.byteLength(excerpt) <= 4096, "tail stays inside its budget")``; ``assert.ok(excerpt.includes("padding line number 399"), "keeps the newest lines")``

- **KEEP** ``capture tolerates a single line longer than the whole tail budget`` (baseline line 99). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.ok(Buffer.byteLength(capture.excerpt()) <= 4096)``



## `apps/daemon/src/agent-host/support/tail-file.test.ts`

Independent source (B1): GUI design §4.5 Claude background shell file output: appended-only reads, valid UTF-8, bounded tail, terminal failure notice and account-home resolution.

Stable seam and refactor tolerance (B4–B5): FileTail over real files; resolveTildePath against explicit provider HOME. No test-only implementation branch is required.

Non-test callers: Claude session background shell output polling/drain.

Lowest distinct owner / remaining stronger coverage (B6): Actual byte split, append/truncation and cap/error outputs are unique lowest filesystem seam; adapter tests do not need to replay file boundary cases.

Cases below name their recognizable failure; “oracle” records the original concrete expected output/state checks (B2–B3), inspected before editing. For REWRITE, the disposition explains which assertion/seam changes; the external contract remains the same.

- **KEEP** ``reads only the bytes appended since the previous read`` (baseline line 26). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(one.text, "first\n")``; ``assert.equal(one.done, false)``; ``assert.equal(two.text, "")``; ``assert.equal(two.done, false)``; ``assert.equal(three.text, "second\n", "only the appended bytes, never the whole file again")``

- **KEEP** ``a multibyte character split across two reads decodes once, whole`` (baseline line 45). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(one.text, prefix, "the dangling lead byte is held back, never rendered as U+FFFD")``; ``assert.equal(two.text, "ébb")``; ``assert.equal(`${one.text}${two.text}`, `${prefix}ébb`)``

- **KEEP** ``stops at the per-shell cap with one truncation notice naming the file`` (baseline line 60). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.deepEqual(await tail.read(), { text: "x".repeat(65536), done: false })``; ``assert.equal(capped.done, true)``; ``assert.ok(capped.text.startsWith("x".repeat(65536)))``; ``assert.ok(capped.text.includes(path), "the notice names the file so the user can read the rest")``; ``assert.deepEqual(three, { text: "", done: true }, "and then nothing, ever again")``

- **KEEP** ``an unreadable file yields ONE notice carrying the code and the path, then nothing`` (baseline line 76). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(one.done, true)``; ``assert.ok(one.text.includes("ENOENT"), one.text)``; ``assert.ok(one.text.includes(path), one.text)``; ``assert.deepEqual(await tail.read(), { text: "", done: true })``

- **KEEP** ``restarts from the beginning when the file is truncated under it`` (baseline line 88). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal((await tail.read()).text, "0123456789")``; ``assert.equal((await tail.read()).text, "new", "a shorter file is a new file, not a negative read")``

- **KEEP** ``resolves a leading ~/ against the CLI's own HOME and leaves everything else alone`` (baseline line 100). Retain the named protocol/state/byte outcome at this file’s distinct seam; its concrete failure oracle is below, and no stronger retained owner covers this input transition.

  Oracle: ``assert.equal(resolveTildePath("~/tmp/a.output", "/homes/acc-1"), "/homes/acc-1/tmp/a.output")``; ``assert.equal(resolveTildePath("~", "/homes/acc-1"), "/homes/acc-1")``; ``assert.equal(resolveTildePath("/var/tmp/a.output", "/homes/acc-1"), "/var/tmp/a.output")``; ``assert.equal(resolveTildePath("~root/x", "/homes/acc-1"), "~root/x")``; ``assert.equal(resolveTildePath("~/tmp/a", ""), "~/tmp/a", "no home, no rewrite")``



## Completed dead-support cleanup

- Internalized `buildClaudeAuth`, `toProviderAuth`, `inferAuth`, `parseLeftoverWork`, `NDJSON_MAX_LINE_BYTES`, `LEFTOVER_WORK_LAUNCHES`, and `LEFTOVER_WORK_SESSIONS`. `rg --text` across apps/packages confirms their only remaining references are inside their production owners. Public production builders, parsers used across packages, and real runtime dependencies remain. No production algorithm changed.

- Removed ten test declarations and the resulting empty describe blocks. Rewrote twelve declarations and kept 294. Shared fixture files remain because provider replay and host composition consumers still use them. The partial-inventory helper in `auth-status.test.ts` was removed; rewritten probes consume raw transport evidence. No otherwise-unused fixture, snapshot, or runtime injection option remains from these deletions.

- Parameterized mappings retained: approval types command/exec/file-read/file-change/apply-patch/MCP/permission plus unknown/auth-refresh; tool lifecycle command/file/MCP/dynamic/collab/search/image and non-tool exclusions; task started/updated/completed linkage; live/snapshot/history phase-word text; interrupted/cancelled/aborted turns; OpenCode/Codex relaunch retention; reasoning summary/raw; turnless assistant/reasoning completion. Their expected literals are authored independently in the input tables, not read from production inventories.

## Validation outcome

- Baseline whole-scope run was interrupted during the agent restart before a completion summary; no failures were emitted before interruption. It is not recorded as a completed pass.
- Changed-file command with the documented import hooks and `--test-concurrency=2`, covering auth-status, pending, activities, fold-integration, ingestion/index, ndjson, and leftover-work: **182 passed, 0 failed**, 35 suites. Log: `/tmp/orquester-test-audit/changed-14.log`.
- Final whole-scope command: `node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test --test-concurrency=2 $(cat /tmp/orquester-test-audit/scope-14.txt)`. All 26 paths passed: **348 tests passed, 0 failed**, 68 suites, no skips/cancellations. Log: `/tmp/orquester-test-audit/final-14.log`. AST reconciliation confirmed 316 original declarations → 306 surviving declarations, including the explicitly mapped rename. Parameterized declarations explain the larger runtime test count.
- Reviewed final test and production diff; scoped `git diff --check` passes. Unrelated import and blank-line formatting was preserved.
- Root owns the repository `pnpm check` and `pnpm test` gates. No browser E2E file is in this scope: host teardown and socket/server cases are process/transport integrations that assert real temporary logs, files, process outcomes, and wire frames before cleanup.
