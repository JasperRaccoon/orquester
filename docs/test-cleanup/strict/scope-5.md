# Strict workflow UI cleanup (scope 5)

Status: completed cleanup. Dispositions were recorded before editing after reviewing every assigned test and its production owner; final implementation and verification are recorded below.

Scope: 42 original files. Specification means `docs/superpowers/specs/2026-09-28-automated-workflows-design.md`, checked against current wire types and callers. No live daemon operations.

## Six-bar interpretation and validation

For each retained row, B1 is the independent source in its file section; B2 is the concrete failure described by the original name and the behavior/oracle below; B3 is the fixed literal input/output assertion (not a value computed by the implementation); B4 is the listed production-consumed pure transformation, public store action/state or protocol parser; B5 permits algorithm/component refactors preserving that boundary and behavior; B6 names the distinct owner and stronger coverage below. Mocks at API seams supply external facts or failures and never perform client state policies. No geometry/copy inventory qualifies.

Risk: removed tests no longer police incidental copy, markup or private helpers. Configuration, storage, wire decoding, asynchronous state and security regressions survive at their owner. Focused validation for every retained file: from `packages/ui`, `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/svg-loader.mjs --import ./test/quiet-mock-timers.mjs --test --test-concurrency=2 <file>`. Root agent owns pnpm check/test/build.

## packages/ui/src/components/right-rail/workflows/workflow-card-problems.test.ts

- **DELETE** `says what the problems are on hover, and what it leaves out` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `is a real button that opens a dialog, named for its workflow` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `is absent with no errors` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `gives focus back to the chip only when dismissed with focus gone down with the panel` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.

## packages/ui/src/components/workflows/canvas/connection.test.ts

B1: Workflow spec §7.2 canvas add/insert/delete and §8.2 pinned-data removal; API patch validates connections separately.

B4/B5 and non-test callers: canvas/ops.ts; WorkflowCanvas.tsx invokes these recipes. Tests observe resulting data/state, not helper calls or component structure.

B2/B3 case oracle family: Final graph edges, node identity and absence of removed pins, independent of positions or rendering.

B6/remaining stronger coverage: daemon/API tests own execution, shared graph validity, expression evaluation and persisted schemas; these cases own the client transformation/navigation/cache and do not replay execution. Deleted duplicate cases below defer to those owners. Risk: ordinary client regression risk; focused command above.

- **DELETE** `accepts an output into a block that takes input` — Shared API validate/patch tests own valid handles, input eligibility, self-loops, duplicate edges and cycles; direct connection/wrapper assertions duplicate that stronger authority (bar 6). UI graph mutation cases remain.
- **DELETE** `refuses cycles, self-loops and duplicates` — Shared API validate/patch tests own valid handles, input eligibility, self-loops, duplicate edges and cycles; direct connection/wrapper assertions duplicate that stronger authority (bar 6). UI graph mutation cases remain.
- **DELETE** `refuses a handle the source does not have, a trigger or a note as target, and notes as a source` — Shared API validate/patch tests own valid handles, input eligibility, self-loops, duplicate edges and cycles; direct connection/wrapper assertions duplicate that stronger authority (bar 6). UI graph mutation cases remain.
- **DELETE** `connectBlocks adds the edge, or returns the workflow untouched` — Shared API validate/patch tests own valid handles, input eligibility, self-loops, duplicate edges and cycles; direct connection/wrapper assertions duplicate that stronger authority (bar 6). UI graph mutation cases remain.
- **KEEP** `adds a block wired from an output` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(added.type, "code");`; `assert.ok(next.edges.some((e) => e.source === "b" && e.target === nodeId));` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `inserts a block into an edge: source → new → target` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.ok(!next.edges.some((e) => e.id === "a-success-b"));`; `assert.ok(next.edges.some((e) => e.source === "a" && e.target === nodeId && e.sourceHandle === "success"));`; `assert.ok(next.edges.some((e) => e.source === nodeId && e.target === "b"));` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `removes blocks with their edges and pinned outputs` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(next.nodes.some((n) => n.id === "a"), false);`; `assert.equal(next.edges.length, 0);`; `assert.deepEqual(next.pinned, {});` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.

## packages/ui/src/components/workflows/canvas/tap-connect.test.ts

B1: Workflow spec §7.4 two-tap output-to-target connection and §3.4 DAG integrity.

B4/B5 and non-test callers: canvas/tap-connect.ts; WorkflowCanvas.tsx dispatches pointer selections. Tests observe resulting data/state, not helper calls or component structure.

B2/B3 case oracle family: A valid target emits exactly the requested edge and returns idle; invalid target emits no edge but permits another choice; cancel/self-tap clear pending intent.

B6/remaining stronger coverage: daemon/API tests own execution, shared graph validity, expression evaluation and persisted schemas; these cases own the client transformation/navigation/cache and do not replay execution. Deleted duplicate cases below defer to those owners. Risk: ordinary client regression risk; focused command above.

- **KEEP** `start → tap a block: connects, back to idle` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(started.state.mode, "picking");`; `assert.equal(started.connect, null);`; `assert.deepEqual(done.connect, { source: "a", sourceHandle: "error", target: "s" });` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `a refused target keeps picking and says why` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(loop.connect, null);`; `assert.equal(loop.state.mode, "picking");`; `assert.ok(loop.state.mode === "picking" && loop.state.refusal);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `its own block or Cancel ends it; a tap while idle does nothing; a new start replaces` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(reduceTapConnect(picking, { type: "tap-node", nodeId: "a" }, wf()).state, TAP_CONNECT_IDLE);`; `assert.deepEqual(reduceTapConnect(picking, { type: "cancel" }, wf()).state, TAP_CONNECT_IDLE);`; `assert.deepEqual(reduceTapConnect(TAP_CONNECT_IDLE, { type: "tap-node", nodeId: "a" }, wf()), { state: TAP_CONNECT_IDLE, connect: null });` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.

## packages/ui/src/components/workflows/inspector/agent-settings-render.check.ts

**DELETE** entire check script. These scenarios exercise generated markup/copy/ids/private React element props rather than a stable action/result interface; they fail bars 1, 3, 4 or 5. Runtime owners are the correspondingly named inspector/forms or controls modules. No unique real behavior is protected by those structural checks; retained config transformations, autocomplete, pinning and editor-store tests cover data contracts; shared API validation owns field validity.

Substantive scenarios inspected:
- DELETE `section labels/summaries and field-anchor inventory` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `error/reveal sections open; unavailable models/options warnings` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `closed fallback copy and card counts` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `orphaned continue block warning` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `fixed account order/check-state markup` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `decision copy and stale warning` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `private card ids/reorder helper shape` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `private config-edit helper calls/saved-prompt copy` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `read-only markup` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.

## packages/ui/src/components/workflows/inspector/flow-settings-render.check.ts

**DELETE** entire check script. These scenarios exercise generated markup/copy/ids/private React element props rather than a stable action/result interface; they fail bars 1, 3, 4 or 5. Runtime owners are the correspondingly named inspector/forms or controls modules. No unique real behavior is protected by those structural checks; retained config transformations, autocomplete, pinning and editor-store tests cover data contracts; shared API validation owns field validity.

Substantive scenarios inspected:
- DELETE `shared rule-guide/operator-label self comparison` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `If rule sentence/anchors/control inventory` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `Switch card counts/folding/label copy/default-removal warning` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `read-only span shape and fallback radio markup` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `Merge guide copy/upstream example` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `Stop guide copy/anchors` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `Wait duration display/unit/zone label markup` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `unknown/alias zone option strings` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `subworkflow description/missing target/open-button/error copy` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `note swatch/textarea markup` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.

## packages/ui/src/components/workflows/inspector/inspector-render.check.ts

**DELETE** entire check script. These scenarios exercise generated markup/copy/ids/private React element props rather than a stable action/result interface; they fail bars 1, 3, 4 or 5. Runtime owners are the correspondingly named inspector/forms or controls modules. No unique real behavior is protected by those structural checks; retained config transformations, autocomplete, pinning and editor-store tests cover data contracts; shared API validation owns field validity.

Substantive scenarios inspected:
- DELETE `CommonSettings summary/anchors/retry copy` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `each block timeout section copy/anchor inventory` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `unused project override copy` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `trigger status copy` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `read-only span/button tag shape` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `DataTab no-run/recorded-run/pin markup, disclosure order, output reference chips` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `trigger/If/Stop/null pin availability markup` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `loading/read-only copy` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `ProblemBar count/collapse markup` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `multi-select disable text and empty inspector text` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `selected node header/pills/badges` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `all block guide rendering compared to imported production declarations` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.

## packages/ui/src/components/workflows/inspector/process-settings-render.check.ts

**DELETE** entire check script. These scenarios exercise generated markup/copy/ids/private React element props rather than a stable action/result interface; they fail bars 1, 3, 4 or 5. Runtime owners are the correspondingly named inspector/forms or controls modules. No unique real behavior is protected by those structural checks; retained config transformations, autocomplete, pinning and editor-store tests cover data contracts; shared API validation owns field validity.

Substantive scenarios inspected:
- DELETE `Code field/limit summary and validation anchors` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `Code shared argument/runtime guide self comparison` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `Shell labels/copy and environment-helper copy` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `read-only and incomplete-expression markup` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `environment row warnings/anchors` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `HTTP field inventory/query disclosure/body summaries` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `header warning/body JSON/default content-type markup` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `success list/timeout unit/error copy` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.

## packages/ui/src/components/workflows/inspector/trigger-settings-edits.check.ts

**DELETE** entire check script. These scenarios exercise generated markup/copy/ids/private React element props rather than a stable action/result interface; they fail bars 1, 3, 4 or 5. Runtime owners are the correspondingly named inspector/forms or controls modules. No unique real behavior is protected by those structural checks; retained config transformations, autocomplete, pinning and editor-store tests cover data contracts; shared API validation owns field validity.

Substantive scenarios inspected:
- DELETE `private React dispatcher/hook harness and element-handler discovery` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `same/switch schedule frequency callbacks` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `minutes/daily/cron edits via private onValue props` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `same/switch repository callback` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `access callback preserves URL/unknown fields` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `same event callback` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `push/tag/release/PR callbacks preserve unknown fields` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.

## packages/ui/src/components/workflows/inspector/trigger-settings-render.check.ts

**DELETE** entire check script. These scenarios exercise generated markup/copy/ids/private React element props rather than a stable action/result interface; they fail bars 1, 3, 4 or 5. Runtime owners are the correspondingly named inspector/forms or controls modules. No unique real behavior is protected by those structural checks; retained config transformations, autocomplete, pinning and editor-store tests cover data contracts; shared API validation owns field validity.

Substantive scenarios inspected:
- DELETE `weekly/minutes/hourly/monthly/custom schedule label and anchor inventory` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `preset/cron mismatch copy/actions` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `project/repository/release/PR/tag labels and control states` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `unknown account/empty URL/temporary repository copy` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `mocked initial-state failed/successful poll copy` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `manual JSON editor/copy/format-button markup` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.

## packages/ui/src/components/workflows/phone/key-bar.test.ts

B1: Workflow spec §7.4 phone key bar and §3.3 expression grammar; conventional selected-text replacement.

B4/B5 and non-test callers: phone/key-bar.ts; KeyBar.tsx applies edits to textareas. Tests observe resulting data/state, not helper calls or component structure.

B2/B3 case oracle family: Inserted literal characters replace only the selected range; expression delimiters wrap the chosen text; indent uses the caller’s unit. Caret offsets locate text insertion, not visual geometry.

B6/remaining stronger coverage: daemon/API tests own execution, shared graph validity, expression evaluation and persisted schemas; these cases own the client transformation/navigation/cache and do not replay execution. Deleted duplicate cases below defer to those owners. Risk: ordinary client regression risk; focused command above.

- **KEEP** `a character replaces the selection; the caret goes after it` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(applyKeyBarKey("ab", 1, 1, ";"), { text: "a;b", selection: 2 });`; `assert.deepEqual(applyKeyBarKey("abcd", 1, 3, "="), { text: "a=d", selection: 2 });`; `assert.deepEqual(applyKeyBarKey("abcd", 3, 1, "|"), { text: "a|d", selection: 2 }, "a backwards selection too");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `{{ }} puts the caret inside, or wraps the selection` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(applyKeyBarKey("Hi ", 3, 3, "expr"), { text: "Hi {{  }}", selection: 6 });`; `assert.deepEqual(applyKeyBarKey("Hi input.name", 3, 13, "expr"), { text: "Hi {{ input.name }}", selection: 19 });` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `Tab indents by the editor's unit` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(applyKeyBarKey("x", 0, 0, "tab"), { text: "  x", selection: 2 });`; `assert.deepEqual(applyKeyBarKey("x", 0, 0, "tab", "\t"), { text: "\tx", selection: 1 });` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.

## packages/ui/src/components/workflows/runs/log-buffer.test.ts

B1: Workflow spec §7.3 readable live log tail; ANSI/CR/newline stream semantics.

B4/B5 and non-test callers: runs/log-buffer.ts; LogViewer.tsx consumes appendLog/visibleLogLines. Tests observe resulting data/state, not helper calls or component structure.

B2/B3 case oracle family: The visible text has no control sequences, preserves chunk splits and replaces CR progress without losing newlines.

B6/remaining stronger coverage: daemon/API tests own execution, shared graph validity, expression evaluation and persisted schemas; these cases own the client transformation/navigation/cache and do not replay execution. Deleted duplicate cases below defer to those owners. Risk: ordinary client regression risk; focused command above.

- **KEEP** `drops colours, cursor moves, OSC titles and links` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(visibleLogLines(state), ["ok done", "progress", "text", "link", "plain", "abc", "tabs\tand", "nothing to do"]);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `carries an escape sequence split across chunks` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(visibleLogLines(state), ["red"]);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `keeps what a terminal would show` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(visibleLogLines(state), ["60%"]);`; `assert.deepEqual(visibleLogLines(state), ["100%", "next"]);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `splits chunks into lines and keeps the line in progress` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(visibleLogLines(state), ["one", "tw"]);`; `assert.deepEqual(visibleLogLines(state), ["one", "two", "three"]);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **DELETE** `caps the lines it keeps and counts the ones it dropped` — Exact 5,000-line/4,000-character presentation budget is an implementation setting without independently fixed bound. Readable streamed text cases remain; whole download is separately retained (bars 1/5).
- **DELETE** `clips a huge line` — Exact 5,000-line/4,000-character presentation budget is an implementation setting without independently fixed bound. Readable streamed text cases remain; whole download is separately retained (bars 1/5).

## packages/ui/src/components/workflows/runs/log-follower.test.ts

B1: Workflow spec §7.3 whole-log download/live viewing; API X-Log-* response cursor in api-client.ts and daemon log route.

B4/B5 and non-test callers: runs/log-follower.ts, api-client.ts; LogViewer.tsx reads both live and downloaded logs. Tests observe resulting data/state, not helper calls or component structure.

B2/B3 case oracle family: Fixed server windows use raw offsets even when redaction grows text; retries preserve the cursor, EOF settles, stop prevents new reads, stalled partial lines poll without spinning, and header bytes parse case-insensitively.

B6/remaining stronger coverage: daemon/API tests own execution, shared graph validity, expression evaluation and persisted schemas; these cases own the client transformation/navigation/cache and do not replay execution. Deleted duplicate cases below defer to those owners. Risk: ordinary client regression risk; focused command above.

- **KEEP** `reads a finished log to its end, window after window, by the daemon's offsets` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(await settled.promise, { following: false, loading: false, error: null });`; `assert.equal(texts.join(""), "a«secret:S»b«secret:S»c\n".repeat(10));`; `assert.deepEqual(s.reads, [0, 7, 14, 21, 28, 35, 42, 49, 56]);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `polls a live log, and a failed read resumes from the same offset once — no duplicates` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(texts, ["one\n"]);`; `assert.deepEqual(await settled.promise, { following: true, loading: false, error: null });`; `assert.deepEqual(texts, ["one\n", "two\n"]);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `an error on a finished log is reported, not appended` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(texts, []);`; `assert.equal(state.following, false);`; `assert.equal(state.loading, false);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `stop() ends it: no further reads, including after wake` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(s.reads, [0]);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `a live log held at a partial last line waits for the next poll instead of spinning` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.ok(reads <= allowedReads);`; `assert.equal(reads, 1);`; `assert.equal(reads, 2);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `readWholeLog reads every window to the end (the download)` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(parts.join(""), "0123456789".repeat(5));` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `parseWorkflowLogWindow reads the X-Log-* headers, case-insensitively` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(window, { text: "abc", nextOffset: 10, eof: false, size: 20, live: true });`; `assert.deepEqual(parseWorkflowLogWindow(data, {}, 7), { text: "abc", nextOffset: 10, eof: true, size: 10, live: false });` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.

## packages/ui/src/components/workflows/steps/steps-logic.test.ts

B1: Workflow spec §7.4 add, move, duplicate, delete and disable actions; §3.4 valid DAG and branch semantics.

B4/B5 and non-test callers: steps/steps-logic.ts; StepsView.tsx invokes graph mutations. Tests observe resulting data/state, not helper calls or component structure.

B2/B3 case oracle family: Fixed node/edge fixtures produce connected chains, preserve unrelated branches, refuse cycles, avoid guessing how to join two parents, and disable only selected nodes.

B6/remaining stronger coverage: daemon/API tests own execution, shared graph validity, expression evaluation and persisted schemas; these cases own the client transformation/navigation/cache and do not replay execution. Deleted duplicate cases below defer to those owners. Risk: ordinary client regression risk; focused command above.

- **DELETE** `rows carry an agent block's first agent, and nothing for other blocks` — Agent-logo decoration repeats catalog blockAgent mapping and checks private row/candidate shape; graph actions below own caller-visible edits (bars 4/6).
- **DELETE** `connect and move candidates carry it too` — Agent-logo decoration repeats catalog blockAgent mapping and checks private row/candidate shape; graph actions below own caller-visible edits (bars 4/6).
- **KEEP** `splices into a chain without losing downstream connections` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(edgesOf(next), [\`a:success>${nodeId}\`, \`${nodeId}:success>b\`, "t:success>a"].sort());` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `a block with no outputs (Stop) never splices: it becomes another branch` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(edgesOf(next), ["a:success>b", \`a:success>${nodeId}\`, "t:success>a"].sort());` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `the first step goes after the trigger; with no trigger, loose` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(edgesOf(first.workflow), [\`t:success>${first.nodeId}\`]);`; `assert.deepEqual(trigger.workflow.nodes.map((n) => [n.id, n.type]), [[trigger.nodeId, "trigger.schedule"]]);`; `assert.equal(trigger.workflow.edges.length, 0);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `connect candidates: connectable first, with why the rest cannot` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.notEqual(review.refusal, null);`; `assert.equal(candidates.some((c) => c.nodeId === "t"), false, "a trigger takes no input");`; `assert.equal(candidates.some((c) => c.nodeId === "b"), false, "not itself");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `move to another output: re-hangs the row's edge; loops are refused` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(candidates.find((c) => c.nodeId === "i" && c.handle === "true")!.current, true);`; `assert.notEqual(candidates.find((c) => c.nodeId === "z")!.refusal, null);`; `assert.deepEqual(edgesOf(moved), ["i:false>y", "t:success>i", "y:success>z"]);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `deleting a middle step heals the chain` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(edgesOf(next), ["t:success>b"]);`; `assert.deepEqual(next.nodes.map((n) => n.id).sort(), ["b", "t"]);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `a join (two edges in) is deleted without guessing a heal` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(edgesOf(deleteStep(wf, "m", mint)), ["t:success>a", "t:success>b"]);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `duplicate puts the copy right after the original, taking over what it fed` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(edgesOf(result.workflow), [\`a:success>${copy}\`, \`${copy}:success>b\`, "t:success>a"].sort());` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `disable / enable` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(off.nodes.filter((n) => n.disabled).map((n) => n.id), ["a"]);`; `assert.equal(on.nodes.some((n) => n.disabled), false);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.

## packages/ui/src/components/workflows/ui/controls-render.check.ts

**DELETE** entire check script. These scenarios exercise generated markup/copy/ids/private React element props rather than a stable action/result interface; they fail bars 1, 3, 4 or 5. Runtime owners are the correspondingly named inspector/forms or controls modules. No unique real behavior is protected by those structural checks; retained config transformations, autocomplete, pinning and editor-store tests cover data contracts; shared API validation owns field validity.

Substantive scenarios inspected:
- DELETE `Section collapse/errors/warnings/sticky classes` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `Field/HelpTip exact generated ids, DOM order and copy` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `segmented/radio/chip markup counts/classes/copy` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `DurationInput units/readouts and generated-id wiring` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `TimeInput/TextArea attributes/classes/row count` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `Callout/disclosure/copy chip markup` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `KeyValueTable private row-message markup` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `Inspector countProblems and anchor grouping` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `Field group tag shape` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `probe calls of private button onClick/onKeyDown props` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.

## packages/ui/src/components/workflows/ui/guide-text-render.check.ts

**DELETE** entire check script. These scenarios exercise generated markup/copy/ids/private React element props rather than a stable action/result interface; they fail bars 1, 3, 4 or 5. Runtime owners are the correspondingly named inspector/forms or controls modules. No unique real behavior is protected by those structural checks; retained config transformations, autocomplete, pinning and editor-store tests cover data contracts; shared API validation owns field validity.

Substantive scenarios inspected:
- DELETE `backtick code-wrapper counts/tag placement/escaping` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `term relabeling and grid class` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.
- DELETE `section header tag/order/copy` — private structure/copy or duplicate shared behavior; no extra runtime seam is retained for it.

## packages/ui/src/lib/workflows/agent-policy-text.test.ts

B1: Workflow spec §5.2 account-policy representation and §7.2 account allow-list/order editor; AGENTS.md preserves unknown stored selections.

B4/B5 and non-test callers: inspector-usage.ts; AccountPolicyEditor.tsx uses view and edits. Tests observe resulting data/state, not helper calls or component structure.

B2/B3 case oracle family: Literal account ids and order express the selected set, explicit System permission and retained missing entries. An empty list means all accounts at the wire boundary and cannot encode a last-account deselection.

B6/remaining stronger coverage: daemon/API tests own execution, shared graph validity, expression evaluation and persisted schemas; these cases own the client transformation/navigation/cache and do not replay execution. Deleted duplicate cases below defer to those owners. Risk: ordinary client regression risk; focused command above.

- **DELETE** `names every strategy and sub-choice` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `lists thresholds 5-hour, weekly, then scoped, and says when a scoped one is limited to models` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `counts accounts` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `summarises a policy in one line` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `applies scoped rules as the engine does` — UI copy helper replays engine scoped-window eligibility rules; daemon account-selection tests are the authority (bar 6).
- **DELETE** `reads threshold breaches, at and over the limit, and used-up windows` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `reads every other reason` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `names who was skipped by label, and a catalogue skip by agent` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `reads each strategy's reason` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `says when the pick is a fallback, with agent labels` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `says when nobody can run it and when the first account frees up` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `names the pick by labels` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **KEEP** `reads no list as every account, the System login last when included` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(allowListView(BASE, managed), { candidates: ["a1", "a2", "a3"], missing: [], explicit: false });`; `assert.deepEqual(allowListView({ ...BASE, accounts: [], includeSystem: true }, managed).candidates, ["a1", "a2", "a3", "system"]);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `matches ids, then labels, keeps list order, and reports entries naming nobody` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(view, { candidates: ["a2", "a1", "system"], missing: ["gone"], explicit: true });`; `assert.deepEqual(allowListView({ ...BASE, accounts: ["system", "a3"] }, managed).candidates, ["system", "a3"]);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `unticks an account into a list, and back to no list when all are ticked` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(off, { accounts: ["a1", "a3"], includeSystem: false });`; `assert.deepEqual(toggleAllowedAccount({ ...BASE, ...off! }, managed, "least-used", "a2"), { accounts: undefined, includeSystem: false });` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `never writes an empty list (the engine would read it as every account)` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(toggleAllowedAccount(only, managed, "least-used", "a1"), null);`; `assert.equal(setSystemAllowed(systemOnly, managed, "least-used", false), null);`; `assert.deepEqual(setSystemAllowed({ ...BASE, includeSystem: true }, [], "least-used", false), { accounts: undefined, includeSystem: false });` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `excludes accounts in fixed order, keeping the order of the rest` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(toggleAllowedAccount(ordered, managed, "fixed", "a1"), { accounts: ["a3", "a2"], includeSystem: false });`; `assert.deepEqual(toggleAllowedAccount({ ...ordered, accounts: ["a3", "a2"] }, managed, "fixed", "a1"), {` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `moves accounts in fixed order and drops a list that is back in the family's order` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(moveAllowedAccount(fixed, managed, "a2", -1), { accounts: ["a2", "a1", "a3"], includeSystem: false });`; `assert.deepEqual(moveAllowedAccount({ ...fixed, accounts: ["a2", "a1", "a3"] }, managed, "a2", 1), { accounts: undefined, includeSystem: false });`; `assert.equal(moveAllowedAccount(fixed, managed, "a1", -1), null);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `adds and removes the System login in a list` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(setSystemAllowed(list, managed, "least-used", true), { accounts: ["a1", "system"], includeSystem: true });`; `assert.deepEqual(setSystemAllowed({ ...list, accounts: ["a1", "system"], includeSystem: true }, managed, "least-used", false), {`; `assert.deepEqual(setSystemAllowed(BASE, managed, "least-used", true), { accounts: undefined, includeSystem: true });` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `keeps entries naming nobody until they are dropped` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(toggleAllowedAccount(stale, managed, "least-used", "a3"), { accounts: ["a1", "a2", "gone"], includeSystem: false });`; `assert.deepEqual(dropMissingAccounts(stale, managed, "least-used"), { accounts: undefined, includeSystem: false });`; `assert.deepEqual(allowAllAccounts({ ...BASE, accounts: ["a2"] }, managed, "fixed"), { accounts: ["a2", "a1", "a3"], includeSystem: false });` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `drops an order-only list when leaving fixed order, and keeps a real restriction` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(leastUsed.strategy, "least-used");`; `assert.equal(leastUsed.accounts, undefined);`; `assert.deepEqual(restricted.accounts, ["a3", "a1"]);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `lists reported windows, each rule for them, then rules for windows not reported` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(scopedLimitRows(undefined, ["Fable"]), [{ label: "Fable", ruleIndex: null }]);`; `assert.deepEqual(` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.

## packages/ui/src/lib/workflows/app-wiring.test.ts

B1: Workflow spec §7.2 one editor tab per project/workflow with title synchronization and §8.1 workflows event channel.

B4/B5 and non-test callers: store/app.ts; MainView, WorkflowsHost and rail actions use the actual app store. Tests observe resulting data/state, not helper calls or component structure.

B2/B3 case oracle family: Real app-store operations route only the workflow channel, focus/reuse intended tabs, preserve or clear explicit run requests, and remove deleted/closed views.

B6/remaining stronger coverage: daemon/API tests own execution, shared graph validity, expression evaluation and persisted schemas; these cases own the client transformation/navigation/cache and do not replay execution. Deleted duplicate cases below defer to those owners. Risk: ordinary client regression risk; focused command above.

- **KEEP** `an upsert and a delete on the workflows channel reach the module store` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(workflowsStore.getState().summaries.get("a")?.name, "Workflow a");`; `assert.equal(workflowsStore.getState().summaries.has("a"), false);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `the same message on another channel does not reach workflows` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(workflowsStore.getState().summaries.size, 0);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `opens one tab per workflow per project, reusing it and updating its run` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.ok(tab);`; `assert.equal(tab.title, "Nightly", "titled after the workflow the store knows");`; `assert.equal(tab.runId, null);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `an unknown workflow takes the caller's title` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(app().workflowTabsByProject[P]?.[0]?.title, "Fresh");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `follows a rename and closes with its workflow, handing the focus on` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(app().workflowTabsByProject[P]?.[0]?.title, "Renamed");`; `assert.equal(app().workflowTabsByProject[Q]?.[0]?.title, "Renamed");`; `assert.deepEqual(app().workflowTabsByProject[P]?.map((t) => t.workflowId), ["b"]);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `closeTab closes a workflow tab like any local tab` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(app().workflowTabsByProject[P], []);`; `assert.equal(app().activeTabByProject[P], null);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.

## packages/ui/src/lib/workflows/catalog-ui.test.ts

- **DELETE** `from an output it offers no triggers and no notes` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `is the agent an agent block runs first` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `is undefined for an agent block with nothing chosen` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `is undefined for any other block` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.

## packages/ui/src/lib/workflows/chain-models.test.ts

B1: Workflow spec §5.1 requires provider-listed model ids; API agent-catalog distinguishes live from provisional catalogs. Credible regression: template opus does not name live opus[1m]; legacy Codex model must not start a fresh chain.

B4/B5 and non-test callers: chain-models.ts and templates.ts; templates/create dialogs and canvas newBlock create config from provider snapshots. Tests observe resulting data/state, not helper calls or component structure.

B2/B3 case oracle family: Hand-authored provider snapshots supply actual slugs/default/legacy markers. Requests must select provider-owned live values, preserve other entries and never replace a stored value using degraded fallback lists.

B6/remaining stronger coverage: daemon/API tests own execution, shared graph validity, expression evaluation and persisted schemas; these cases own the client transformation/navigation/cache and do not replay execution. Deleted duplicate cases below defer to those owners. Risk: ordinary client regression risk; focused command above.

- **DELETE** `strips a trailing [variant] only` — Private slug helper or catalog-count/wrapper duplicate; creation request/provider-list regressions below retain actual model selection behavior (bars 4/6).
- **DELETE** `keeps a listed slug` — Private slug helper or catalog-count/wrapper duplicate; creation request/provider-list regressions below retain actual model selection behavior (bars 4/6).
- **DELETE** `takes a listed slug of the same family` — Private slug helper or catalog-count/wrapper duplicate; creation request/provider-list regressions below retain actual model selection behavior (bars 4/6).
- **DELETE** `falls back to the provider's default, then its first model` — Private slug helper or catalog-count/wrapper duplicate; creation request/provider-list regressions below retain actual model selection behavior (bars 4/6).
- **DELETE** `passes over a legacy model for the default` — Private slug helper or catalog-count/wrapper duplicate; creation request/provider-list regressions below retain actual model selection behavior (bars 4/6).
- **DELETE** `leaves the slug as is with no models` — Private slug helper or catalog-count/wrapper duplicate; creation request/provider-list regressions below retain actual model selection behavior (bars 4/6).
- **DELETE** `matches case exactly (no folding)` — Private slug helper or catalog-count/wrapper duplicate; creation request/provider-list regressions below retain actual model selection behavior (bars 4/6).
- **REWRITE** `resolves each entry against its own agent's loaded catalogue and keeps the rest` — Retains the named data/protocol contract; removes exact prose, object-identity or private helper expectations and observes preserved data/state through the production seam.
  - Final B2/B3 witness after rewrite: `assert.deepEqual( resolved.map((entry) => [entry.agent, entry.model]), [ ["claude", "opus[1m]"], ["codex", "gpt-6-sol"], ["grok", "grok-4"] ] )`; `assert.deepEqual(resolved[0]!.accounts, chain[0]!.accounts)`; `assert.deepEqual(resolved[1], chain[1])` Fixed data and state are the oracle; removed private identity/prose assertions are not retention requirements.
- **REWRITE** `never resolves against a list that may be a fallback: pending, degraded or errored` — Retains the named data/protocol contract; removes exact prose, object-identity or private helper expectations and observes preserved data/state through the production seam.
  - Final B2/B3 witness after rewrite: `assert.equal((resolved.nodes![0]!.config as { chain: AgentChainEntry[] }).chain[0]!.model, "opus[1m]", status)`; `assert.equal(liveDefaultNodeConfig("agent", providers).chain[0]!.model, "default", status)` Fixed data and state are the oracle; removed private identity/prose assertions are not retention requirements.
- **DELETE** ``${template.id}: every agent block names a listed model and validates without a model error`` — Private slug helper or catalog-count/wrapper duplicate; creation request/provider-list regressions below retain actual model selection behavior (bars 4/6).
- **KEEP** `the Codex reviewer keeps the current default, gpt-6-astra` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal((agent?.config as { chain: AgentChainEntry[] }).chain[0]!.model, "gpt-6-astra");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **REWRITE** `an old static `opus` resolves to `opus[1m]`` — Retains the named data/protocol contract; removes exact prose, object-identity or private helper expectations and observes preserved data/state through the production seam.
  - Final B2/B3 witness after rewrite: `assert.deepEqual((resolved.nodes?.[1]?.config as { chain: AgentChainEntry[] }).chain, [{ agent: "claude", model: "opus[1m]" }])`; `assert.deepEqual(resolved.nodes?.[0], { type: "trigger.manual", config: {} })` Fixed data and state are the oracle; removed private identity/prose assertions are not retention requirements.
- **KEEP** `without a catalogue the request is untouched` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal((agent?.config as { chain: AgentChainEntry[] }).chain[0]!.model, "default");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `a fresh agent block names a listed model; other blocks are their defaults` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(config.chain[0]!.model, "default");`; `assert.equal(liveDefaultNodeConfig("agent", other).chain[0]!.model, "sonnet");`; `assert.deepEqual(liveDefaultNodeConfig("trigger.manual", LIVE), {});` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **DELETE** `is absent until the registry lists a chat agent` — Private slug helper or catalog-count/wrapper duplicate; creation request/provider-list regressions below retain actual model selection behavior (bars 4/6).
- **DELETE** `lists each chat agent with its probed models` — Private slug helper or catalog-count/wrapper duplicate; creation request/provider-list regressions below retain actual model selection behavior (bars 4/6).

## packages/ui/src/lib/workflows/clipboard.test.ts

B1: Workflow spec §7.2 marked JSON clipboard, fresh identities, cross-workflow pastes and reference preservation; AGENTS.md validate bridge payloads.

B4/B5 and non-test callers: clipboard.ts; WorkflowCanvas and Steps use copy/paste/duplicate. Tests observe resulting data/state, not helper calls or component structure.

B2/B3 case oracle family: Literal marker/version, chosen node ids, endpoint sets, fresh ids and name references detect foreign clipboard acceptance, dangling edges, name collisions and cascading rename corruption.

B6/remaining stronger coverage: daemon/API tests own execution, shared graph validity, expression evaluation and persisted schemas; these cases own the client transformation/navigation/cache and do not replay execution. Deleted duplicate cases below defer to those owners. Risk: ordinary client regression risk; focused command above.

- **KEEP** `carries the selected blocks and only the edges between them, under the marker` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(clip["orquester.workflow-clipboard"], 1);`; `assert.deepEqual(clip.nodes.map((n: { id: string }) => n.id), ["a", "h"]);`; `assert.deepEqual(clip.edges.map((e: { id: string }) => e.id), ["a-success-h"]);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `is not fooled by other text, or by a payload whose blocks do not parse` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(parseWorkflowClipboard("hello"), null);`; `assert.equal(parseWorkflowClipboard(JSON.stringify(unsupported)), null);`; `assert.equal(parseWorkflowClipboard(\`{"orquester.workflow-clipboard": 1, "nodes": [{"id": "x"}]}\`), null);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `re-mints ids and names and keeps inner edges and references` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(nodeIds.length, 3);`; `assert.deepEqual(added.map((n) => n.name), ["Review2", "Post2", "Followup2"]);`; `assert.ok(added.every((n) => !["a", "h", "c"].includes(n.id)));` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `keeps a name that is free in the target workflow (a paste across workflows)` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.ok(post, "the name survives");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `does not turn A→B, B→C renames into A→C` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(x?.name, "Post3");`; `assert.equal(x?.type === "http" ? x.config.url : null, "{{ nodes.Post3.output }} {{ nodes.Post4.output }}");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.

## packages/ui/src/lib/workflows/deep-link.test.ts

B1: Workflow spec §5.11 push opens run and §7.2 workflow tabs; service-worker message and URL keys in apps/web public sw.

B4/B5 and non-test callers: deep-link.ts; apps/web host and WorkflowsHost consume it. Tests observe resulting data/state, not helper calls or component structure.

B2/B3 case oracle family: Exact workflow/run URL/message identifiers, once-only pending delivery and target project are externally visible navigation contracts; arbitrary unrelated query/hash data stays intact.

B6/remaining stronger coverage: daemon/API tests own execution, shared graph validity, expression evaluation and persisted schemas; these cases own the client transformation/navigation/cache and do not replay execution. Deleted duplicate cases below defer to those owners. Risk: ordinary client regression risk; focused command above.

- **KEEP** `parses ?workflow=&run=` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(parseWorkflowDeepLink("?workflow=wf-1&run=run-2"), { workflowId: "wf-1", runId: "run-2" });`; `assert.deepEqual(parseWorkflowDeepLink("workflow=wf-1"), { workflowId: "wf-1", runId: null });`; `assert.deepEqual(parseWorkflowDeepLink("?workflow=wf-1&run=%3Cscript%3E"), { workflowId: "wf-1", runId: null });` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `strips its parameters and keeps the rest` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(stripWorkflowDeepLink("https://o.example.com/?workflow=a&run=b"), "/");`; `assert.equal(stripWorkflowDeepLink("https://o.example.com/app?x=1&workflow=a#h"), "/app?x=1#h");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `parses the service worker's message; anything else is null` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(parseWorkflowRunMessage({ type: "orquester:open-workflow-run", workflowId: "w", runId: "r" }), { workflowId: "w", runId: "r" });`; `assert.equal(parseWorkflowRunMessage({ type: "other", workflowId: "w" }), null);`; `assert.equal(parseWorkflowRunMessage({ type: "orquester:open-workflow-run", workflowId: 3 }), null);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `one pending link, taken once, listeners told` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(told, 2);`; `assert.deepEqual(pendingWorkflowDeepLink(), { workflowId: "b", runId: "r" });`; `assert.deepEqual(takeWorkflowDeepLink(), { workflowId: "b", runId: "r" });` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `waits for the connection and the workflows, opens in the workflow's own project` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(decideDeepLink({ ...base, connected: false, workflow: null }), { kind: "wait" });`; `assert.deepEqual(decideDeepLink({ ...base, workflowsLoaded: false, workflow: null }), { kind: "wait" });`; `assert.deepEqual(decideDeepLink({ ...base, workflow: { projectPath: "/w/x/own" } }), { kind: "open", projectPath: "/w/x/own" });` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.

## packages/ui/src/lib/workflows/durations.test.ts

B1: Workflow config fields store canonical minutes/seconds with schema bounds; conventional unit arithmetic (60 seconds/minute, 60 minutes/hour, 24 hours/day).

B4/B5 and non-test callers: durations.ts; DurationInput calls canonicalDuration on edits. Tests observe resulting data/state, not helper calls or component structure.

B2/B3 case oracle family: Literal 0.1 h → 6 min, 1/3 h → 20 min, 1.5 min → 90 s and canonical min/max constraints detect saved duration drift. Formatting and display preferences are removed.

B6/remaining stronger coverage: daemon/API tests own execution, shared graph validity, expression evaluation and persisted schemas; these cases own the client transformation/navigation/cache and do not replay execution. Deleted duplicate cases below defer to those owners. Risk: ordinary client regression risk; focused command above.

- **DELETE** `reads whole units plainly` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `keeps every non-zero part` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `reads zero in its own unit and refuses nonsense` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `formats a count in one unit` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `converts between units without float noise` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `picks the largest offered unit that holds the value whole` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `falls back to the canonical unit, else the smallest offered` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **KEEP** `converts typed values to the canonical unit without float noise` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(canonicalDuration(0.5, "hours", "minutes"), 30);`; `assert.equal(canonicalDuration(0.1, "hours", "minutes"), 6);`; `assert.equal(canonicalDuration(1 / 3, "hours", "minutes"), 20);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `clamps in the canonical unit, never at a converted bound` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(canonicalDuration(0, "hours", "minutes", 1, 1440), 1);`; `assert.equal(canonicalDuration(30, "hours", "minutes", 1, 1440), 1440);`; `assert.equal(canonicalDuration(2, "days", "minutes", 1, 10080), 2880);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.

## packages/ui/src/lib/workflows/editor-store.test.ts

B1: Workflow spec §7.2 revision-aware autosave, explicit conflict handling, undo/redo and continuous validation; §8.1 replace/patch API; AGENTS.md stale payload/reconnection isolation.

B4/B5 and non-test callers: editor-store.ts; useWorkflowEditor and lifecycle handlers are production callers. Tests observe resulting data/state, not helper calls or component structure.

B2/B3 case oracle family: Fixed edits, server revisions and controlled pending responses expose lost drafts, overlapping saves, false echo conflicts, stale writes, invalid enabled saves, reconnect mixing and missed lifecycle flush. The fake server supplies responses; it does not implement editor debounce/history/conflict policy.

B6/remaining stronger coverage: daemon/API tests own execution, shared graph validity, expression evaluation and persisted schemas; these cases own the client transformation/navigation/cache and do not replay execution. Deleted duplicate cases below defer to those owners. Risk: ordinary client regression risk; focused command above.

- **KEEP** `a missing workflow is an error with words, not a crash` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(editor.state.status, "error");`; `assert.equal(editor.state.draft, null);`; `assert.ok(editor.state.loadError);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `saves 600 ms after the last change, once, with the revision the draft is based on` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(api.puts.length, 0, "nothing before the quiet period ends");`; `assert.equal(editor.state.saveState, "pending");`; `assert.equal(api.puts.length, 1);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `the body leaves out the daemon's own fields` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `for (const key of ["id", "revision", "createdAt", "updatedAt"]) assert.equal(key in body, false, key);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `serializes saves: a change during a save is saved right after it, on the new revision` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(api.puts.length, 1);`; `assert.equal(api.puts.length, 1, "no second PUT while the first is in flight");`; `assert.equal(api.puts.length, 2);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `a failed save says so and keeps the edit; flush retries it` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(editor.state.saveState, "error");`; `assert.equal(editor.state.saveError, "Network down");`; `assert.equal(editor.state.draft?.name, "Kept");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `an enabled draft the daemon refuses as invalid is saved disabled, and the editor says so` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(api.server.enabled, false);`; `assert.equal(api.server.name, "Broken");`; `assert.equal(editor.state.draft?.enabled, false);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `a 409 raises the banner and stops autosaving` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(editor.state.conflict, { kind: "save" });`; `assert.equal(editor.state.saveState, "conflict");`; `assert.equal(api.puts.length, 1, "no autosave while in conflict");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `Reload takes their copy and drops the edits (and the undo history)` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(editor.state.conflict, null);`; `assert.equal(editor.state.draft?.name, "Theirs");`; `assert.equal(editor.state.revision, 2);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `Keep mine overwrites theirs with the draft` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(editor.state.conflict, null);`; `assert.equal(api.server.name, "Mine");`; `assert.equal(editor.state.saveState, "saved");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `a newer revision while clean reloads silently` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(editor.state.draft?.name, "From the MCP");`; `assert.equal(editor.state.conflict, null);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `a newer revision over unsaved edits raises the banner` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(editor.state.conflict, { kind: "remote" });`; `assert.equal(editor.state.draft?.name, "Mine", "the draft is kept for Keep mine");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `an own-save event before its response preserves the draft without a false conflict` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(editor.state.conflict, null);`; `assert.equal(editor.state.draft?.name, "Mine");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `undo drops a selection of blocks the older draft does not have` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(editor.state.selection.nodeIds, []);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `enabling saves pending edits first, then patches set_enabled on the new revision` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(await editor.setEnabled(true), null);`; `assert.equal(api.puts.length, 1);`; `assert.deepEqual(api.patches[0], { revision: 2, ops: [{ op: "set_enabled", enabled: true }] });` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `validates the draft a moment after each change` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.ok(editor.state.problems.some((problem) => problem.code === "unknown_reference" && problem.nodeId === "a"));` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `marks a model the live catalogue does not list, as the daemon does — and follows the catalogue` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(editor.state.problems.filter((problem) => problem.code === "unknown_model").length, 0, "no catalogue, no check");`; `assert.ok(live);`; `assert.deepEqual(models.map((problem) => [problem.severity, problem.nodeId, problem.field]), [["error", "a", "config.chain.0.model"]]);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `a catalogue not loaded yet raises no false errors` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(editorAgentCatalog([], []), undefined);`; `assert.deepEqual(models.map((problem) => problem.severity), ["warning"]);`; `assert.equal(editor.state.problems.some((problem) => problem.severity === "error"), false);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `a reconnect's new client keeps the same editor and its unsaved draft (keyed by connection id)` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(again.state.draft?.name, "Typing");`; `assert.equal(first.puts.length, 0, "the old client is not used any more");`; `assert.equal(second.puts.length, 1);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `a load that lands after the user typed keeps the edit and raises the banner` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(editor.state.draft?.name, "Mine");`; `assert.deepEqual(editor.state.conflict, { kind: "remote" });` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `an Enable event before its response preserves enabled state without a false conflict` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(await editor.setEnabled(true), null);`; `assert.equal(editor.state.revision, 2);`; `assert.equal(editor.state.draft?.enabled, true);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `undo never flips enabled` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(editor.state.draft?.name, "Test");`; `assert.equal(editor.state.draft?.enabled, true);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `reconnect: a failed save is retried; a newer daemon revision is a conflict` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(editor.state.saveState, "error");`; `assert.equal(editor.state.saveState, "saved");`; `assert.equal(api.server.name, "Kept");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `flushAllWorkflowEditors saves a pending edit at once (pagehide)` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(api.server.name, "Leaving");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.

## packages/ui/src/lib/workflows/flow-settings.test.ts

B1: AGENTS.md tolerant persisted configs preserve unknown fields; workflow config discriminated union has mutually exclusive duration/until fields.

B4/B5 and non-test callers: flow-settings.ts; WaitSettings calls waitConfigForKind. Tests observe resulting data/state, not helper calls or component structure.

B2/B3 case oracle family: Changing kind drops known fields of the old variant while preserving an explicit unknown note; selecting the existing variant preserves its value (no identity requirement).

B6/remaining stronger coverage: daemon/API tests own execution, shared graph validity, expression evaluation and persisted schemas; these cases own the client transformation/navigation/cache and do not replay execution. Deleted duplicate cases below defer to those owners. Risk: ordinary client regression risk; focused command above.

- **DELETE** `reads one rule as written, several as a count and how they combine` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `names an output by its label, else by its number` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `notes an empty label and warns on a repeated one` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `lists the blocks wired into it once each, and shows its output by their names` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **REWRITE** `drops the other kind's fields and keeps unknown ones` — Retains the named data/protocol contract; removes exact prose, object-identity or private helper expectations and observes preserved data/state through the production seam.
  - Final B2/B3 witness after rewrite: `assert.deepEqual(waitConfigForKind(duration, "until"), { kind: "until", time: "09:00", note: "kept" })`; `assert.deepEqual(waitConfigForKind(until, "duration"), { kind: "duration", minutes: 5, note: "kept" })`; `assert.deepEqual(waitConfigForKind(until, "until"), until, "the same kind is left as is")` Fixed data and state are the oracle; removed private identity/prose assertions are not retention requirements.
- **DELETE** `reads underscores as spaces` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.

## packages/ui/src/lib/workflows/format.test.ts

B1: Workflow spec §7.1 scope/search/run list, §6.2 trigger errors, §7.2 creation toolbar and §5.10 project choices; API CreateWorkflowRequest and schema limits.

B4/B5 and non-test callers: format.ts/new-workflow.ts/templates.ts; rail card, list and NewWorkflowDialog consume these values. Tests observe resulting data/state, not helper calls or component structure.

B2/B3 case oracle family: Fixed runs supply exact durations/states; known ids determine filters; creation maps chosen existing/clone projects and timezone into the wire request; missing fields produce field identifiers rather than asserted English copy.

B6/remaining stronger coverage: daemon/API tests own execution, shared graph validity, expression evaluation and persisted schemas; these cases own the client transformation/navigation/cache and do not replay execution. Deleted duplicate cases below defer to those owners. Risk: ordinary client regression risk; focused command above.

- **KEEP** `times a run: its duration once ended, the time so far while running` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(runElapsedMs(run(), NOW), 12 * 60_000);`; `assert.equal(runElapsedMs(run({ status: "succeeded", durationMs: 4_000 }), NOW), 4_000);`; `assert.equal(runElapsedMs(run({ status: "failed", startedAt: undefined }), NOW), null);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `shows the running run over a queued one` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(liveRunOf(summary({ id: "w", activeRuns: [queued, running] }))?.id, "r");`; `assert.equal(liveRunOf(summary({ id: "w" })), null);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `filters by scope, by running, and by the search` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(filterWorkflows(list, "all", "/w/acme/app", "").map((w) => w.id), ["a", "b", "c"]);`; `assert.deepEqual(filterWorkflows(list, "project", "/w/acme/app/", "").map((w) => w.id), ["a"]);`; `assert.deepEqual(filterWorkflows(list, "project", "/w/acme/other", "").map((w) => w.id), ["b"]);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `a blank workflow is one manual trigger the daemon names and places, in the browser's time zone` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(blankWorkflowRequest("  Deploy  ", project, "Europe/Madrid"), {` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `defaults to this project, and resolves each target` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(resolveNewWorkflow(draft, P), {`; `assert.equal(initialNewWorkflowDraft("").target, "other", "no project open: pick one");`; `assert.deepEqual(resolveNewWorkflow({ ...draft, target: "other", otherPath: "/w/acme/api" }, P), {` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `names the first thing missing` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal((resolveNewWorkflow(draft, P) as { field: string }).field, "name");`; `assert.equal(resolveNewWorkflow({ ...named, target: "other" }, P).ok, false);`; `assert.equal((resolveNewWorkflow({ ...named, target: "temp" }, P) as { field: string }).field, "workspace");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `maps each trigger whose last poll failed to its error, and nothing else` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual([...errors], [["git", "ls-remote: authentication failed"]]);`; `assert.equal(triggerErrorsOf(null).size, 0);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.

## packages/ui/src/lib/workflows/guide-text.test.ts

- **DELETE** `turns backtick spans into code runs` — Private split-run representation and guide/export/title inventories; imported guide expectations restate declarations (bars 1/3/4/5). Rendering uses React text escaping; expression byte contracts remain in autocomplete/outputReference tests.
- **DELETE** `keeps plain text, code at the edges, and never makes empty runs` — Private split-run representation and guide/export/title inventories; imported guide expectations restate declarations (bars 1/3/4/5). Rendering uses React text escaping; expression byte contracts remain in autocomplete/outputReference tests.
- **DELETE** `leaves an unpaired backtick in the text as written` — Private split-run representation and guide/export/title inventories; imported guide expectations restate declarations (bars 1/3/4/5). Rendering uses React text escaping; expression byte contracts remain in autocomplete/outputReference tests.
- **DELETE** `keeps code characters (braces, quotes, pipes) as they are` — Private split-run representation and guide/export/title inventories; imported guide expectations restate declarations (bars 1/3/4/5). Rendering uses React text escaping; expression byte contracts remain in autocomplete/outputReference tests.
- **DELETE** `names only sections the shared guide has` — Private split-run representation and guide/export/title inventories; imported guide expectations restate declarations (bars 1/3/4/5). Rendering uses React text escaping; expression byte contracts remain in autocomplete/outputReference tests.
- **DELETE** `finds every section and fact the block forms read by title or term` — Private split-run representation and guide/export/title inventories; imported guide expectations restate declarations (bars 1/3/4/5). Rendering uses React text escaping; expression byte contracts remain in autocomplete/outputReference tests.

## packages/ui/src/lib/workflows/history.test.ts

B1: Workflow spec §7.2 explicitly requires snapshot undo/redo, coalesced drags and 100 steps.

B4/B5 and non-test callers: history.ts; WorkflowEditor records/seals/undoes snapshots. Tests observe resulting data/state, not helper calls or component structure.

B2/B3 case oracle family: Explicit historical values must be returned in reverse/forward order; coalesced bursts undo once, a new edit drops redo, and 150 changes retain the newest 100.

B6/remaining stronger coverage: daemon/API tests own execution, shared graph validity, expression evaluation and persisted schemas; these cases own the client transformation/navigation/cache and do not replay execution. Deleted duplicate cases below defer to those owners. Risk: ordinary client regression risk; focused command above.

- **KEEP** `undo hands back the state before each change, redo walks forward again` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(history.undo("c"), "b");`; `assert.equal(history.undo("b"), "a");`; `assert.equal(history.undo("a"), null);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `a burst with one key is one step; a pause or another key starts a new one` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(history.undo("d"), "c", "another key is another edit");`; `assert.equal(history.undo("c"), "b", "a pause separates edits");`; `assert.equal(history.undo("b"), "a", "the whole drag undoes to where it started");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `a null key never coalesces, and seal() ends a burst early` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(history.undo(5), 4);`; `assert.equal(history.undo(4), 3);`; `assert.equal(history.undo(3), 2);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `a new change after an undo drops what could be redone` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(history.canRedo, true);`; `assert.equal(history.canRedo, false);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `keeps at most 100 steps, dropping the oldest` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(count, 100);`; `assert.equal(current, 50);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.

## packages/ui/src/lib/workflows/inspector-autocomplete.test.ts

B1: Workflow spec §7.2 expression and prompt-variable autocomplete; §3.2/§3.3 wire expression roots/outputs/filters.

B4/B5 and non-test callers: inspector-autocomplete.ts; TemplateEditor uses completionScopeFor/templateCompletions. Tests observe resulting data/state, not helper calls or component structure.

B2/B3 case oracle family: Manually listed grammar tokens and upstream names identify valid suggestions; text replacement offsets protect editing the typed token, not DOM layout. Closed/escaped expressions must not offer insertion.

B6/remaining stronger coverage: daemon/API tests own execution, shared graph validity, expression evaluation and persisted schemas; these cases own the client transformation/navigation/cache and do not replay execution. Deleted duplicate cases below defer to those owners. Risk: ordinary client regression risk; focused command above.

- **KEEP** `offers the roots right after {{` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(labels("Hi {{ ")?.sort(), ["input", "nodes", "project", "run", "secrets", "trigger", "workflow"]);`; `assert.deepEqual(labels("{{no"), ["nodes"]);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `walks nodes → a block → output → its known fields, from the caret back` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(labels("{{ nodes.")?.sort(), ["Fetch", "OnTag", "Review"]);`; `assert.deepEqual(labels("{{ nodes.Re"), ["Review"]);`; `assert.deepEqual(labels("{{ nodes.Review.")?.sort(), ["error", "output", "status"]);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `knows the trigger's fields, the run, the project, the secrets and the input` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.ok(labels("{{ trigger.")?.includes("tag"));`; `assert.deepEqual(labels("{{ trigger.release.")?.sort(), ["body", "id", "name", "prerelease", "tag", "url"]);`; `assert.deepEqual(labels("{{ run.")?.sort(), ["attempt", "id", "startedAt", "workflowId", "workflowName"]);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `offers filters after a pipe, with arguments filled in` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(answer?.options.map((o) => [o.label, o.apply]), [["default", 'default("")']]);`; `assert.ok(labels("{{ input.text | ")?.includes("json"));` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `says nothing outside an expression, after one closed, or after an escape` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(labels("plain text"), null);`; `assert.equal(labels("{{ input }} and "), null);`; `assert.equal(labels("\\{{ nodes."), null);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `offers {variables} in a prompt only, and never inside {{` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(answer?.options.map((o) => [o.label, o.apply]), [["branch", "branch}"]]);`; `assert.equal(labels("On {br", scope()), null);`; `assert.ok(labels("On {", prompt)?.includes("diff"));` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **DELETE** `explains roots, block fields, secrets and filters with the shared guide's text` — Expected documentation is imported from the same guide the implementation consumes; self-consistency/export inventory, not independent completion behavior (bar 3).

## packages/ui/src/lib/workflows/inspector-data.test.ts

B1: Workflow spec §3.1 pinned-data size, §7.6 tests use pinned outputs, §8.2 set_pinned null unpins, §3.3 expression path bytes.

B4/B5 and non-test callers: inspector-data.ts; DataTab consumes parser/reference output. Tests observe resulting data/state, not helper calls or component structure.

B2/B3 case oracle family: Fixed JSON byte overflow rejects; null is refused but false/zero are preserved; syntax errors return failure; copied output reference names the requested block. Error wording is not asserted.

B6/remaining stronger coverage: daemon/API tests own execution, shared graph validity, expression evaluation and persisted schemas; these cases own the client transformation/navigation/cache and do not replay execution. Deleted duplicate cases below defer to those owners. Risk: ordinary client regression risk; focused command above.

- **DELETE** `pins blocks that finish on a plain success output` — Pin predicate/default-draft helper duplicates daemon pin eligibility, whole-output selection or retained null/syntax parsing; notice wording has no exact-copy contract (bars 1/6).
- **DELETE** `never pins triggers, branching blocks, Stop or notes (the engine would ignore the pin)` — Pin predicate/default-draft helper duplicates daemon pin eligibility, whole-output selection or retained null/syntax parsing; notice wording has no exact-copy contract (bars 1/6).
- **DELETE** `starts from the latest output when it is whole` — Pin predicate/default-draft helper duplicates daemon pin eligibility, whole-output selection or retained null/syntax parsing; notice wording has no exact-copy contract (bars 1/6).
- **DELETE** `starts from an empty object without an output, or with only a preview` — Pin predicate/default-draft helper duplicates daemon pin eligibility, whole-output selection or retained null/syntax parsing; notice wording has no exact-copy contract (bars 1/6).
- **REWRITE** `refuses JSON over the pinned-data limit` — Retains the named data/protocol contract; removes exact prose, object-identity or private helper expectations and observes preserved data/state through the production seam.
  - Final B2/B3 witness after rewrite: `assert.equal(parsed.ok, false)`; `assert.ok(!parsed.ok && parsed.error.length > 0)` Fixed data and state are the oracle; removed private identity/prose assertions are not retention requirements.
- **REWRITE** `refuses null, which set_pinned would read as unpin` — Retains the named data/protocol contract; removes exact prose, object-identity or private helper expectations and observes preserved data/state through the production seam.
  - Final B2/B3 witness after rewrite: `assert.equal(parsed.ok, false)`; `assert.deepEqual(parsePinnedText("false"), { ok: true, value: false })`; `assert.deepEqual(parsePinnedText("0"), { ok: true, value: 0 })` Fixed data and state are the oracle; removed private identity/prose assertions are not retention requirements.
- **REWRITE** `explains a syntax error` — Retains the named data/protocol contract; removes exact prose, object-identity or private helper expectations and observes preserved data/state through the production seam.
  - Final B2/B3 witness after rewrite: `assert.equal(parsed.ok, false)`; `assert.ok(!parsed.ok && parsed.error.length > 0)` Fixed data and state are the oracle; removed private identity/prose assertions are not retention requirements.
- **KEEP** `writes the template reference to a block's output` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(outputReference("Review"), "{{ nodes.Review.output }}");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **DELETE** `says why a test did not start, in words` — Pin predicate/default-draft helper duplicates daemon pin eligibility, whole-output selection or retained null/syntax parsing; notice wording has no exact-copy contract (bars 1/6).
- **DELETE** `anything but null / undefined` — Pin predicate/default-draft helper duplicates daemon pin eligibility, whole-output selection or retained null/syntax parsing; notice wording has no exact-copy contract (bars 1/6).

## packages/ui/src/lib/workflows/inspector-pin.test.ts

B1: Workflow spec §8.1 capped recorded output and whole-output endpoint; §7.6 pin must be real output.

B4/B5 and non-test callers: inspector-data.ts; DataTab pinFromRun calls pinnableOutputOf. Tests observe resulting data/state, not helper calls or component structure.

B2/B3 case oracle family: Whole data pins without I/O; truncated preview is replaced by fetched output; malformed response rejects so the preview cannot become a pin.

B6/remaining stronger coverage: daemon/API tests own execution, shared graph validity, expression evaluation and persisted schemas; these cases own the client transformation/navigation/cache and do not replay execution. Deleted duplicate cases below defer to those owners. Risk: ordinary client regression risk; focused command above.

- **KEEP** `pins a whole recorded output as is, without asking the daemon` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(value, { a: 1 });`; `assert.equal(asked, 0);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `reads the whole output when the run kept only a preview` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(value, { full: "xxxxxxxxxx" });` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `refuses a malformed answer rather than pinning the preview` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `await assert.rejects(pinnableOutputOf({ output: "p", outputTruncated: true }, async () => null));` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.

## packages/ui/src/lib/workflows/inspector-support.test.ts

B1: Workflow spec §7.2 live account usage keyed by id; §5.2 expired/stale usage; AGENTS.md validates localStorage before typed UI state.

B4/B5 and non-test callers: inspector-usage.ts and inspector-layout.ts; AccountPolicyEditor and editor shell read them. Tests observe resulting data/state, not helper calls or component structure.

B2/B3 case oracle family: Fixed account ids retain only the right family/windows and mark expired/stale readings unknown; invalid stored fields are repaired independently and valid booleans survive.

B6/remaining stronger coverage: daemon/API tests own execution, shared graph validity, expression evaluation and persisted schemas; these cases own the client transformation/navigation/cache and do not replay execution. Deleted duplicate cases below defer to those owners. Risk: ordinary client regression risk; focused command above.

- **KEEP** `joins managed accounts to their windows by id; an expired window says nothing` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(rows.map((row) => row.id), ["jasper", "eduard", "system"]);`; `assert.equal(rows[0]!.weekly?.percent, 63);`; `assert.deepEqual(rows[0]!.scoped.map((bar) => bar.label), ["Fable"]);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **DELETE** `families: an agent's own; OpenCode and agents this build does not offer have none` — Duplicates stronger parsePinnedText/run-view input cases or static account-family inventory. Retained usage joining and storage validation own distinct behavior (bar 6).
- **KEEP** `loads persisted choices field by field and falls back on unreadable data` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(stored.paletteOpen, false);`; `assert.equal(stored.minimap, true);`; `assert.ok(Number.isFinite(stored.inspectorWidth));` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **DELETE** `a block's input is its one live upstream's output, or the merge object` — Duplicates stronger parsePinnedText/run-view input cases or static account-family inventory. Retained usage joining and storage validation own distinct behavior (bar 6).
- **DELETE** `a pinned output is JSON, or an error that says why` — Duplicates stronger parsePinnedText/run-view input cases or static account-family inventory. Retained usage joining and storage validation own distinct behavior (bar 6).

## packages/ui/src/lib/workflows/json-tree.test.ts

B1: Workflow spec §7.3 JSON input/output viewer and copying; §3.3 expression paths and bounded output handling.

B4/B5 and non-test callers: json-tree.ts; JsonTree.tsx consumes children and copy text. Tests observe resulting data/state, not helper calls or component structure.

B2/B3 case oracle family: Quoted property names use escaped bracket syntax, array page offsets select the right values/paths, and copied objects parse back to the original JSON data (not markup).

B6/remaining stronger coverage: daemon/API tests own execution, shared graph validity, expression evaluation and persisted schemas; these cases own the client transformation/navigation/cache and do not replay execution. Deleted duplicate cases below defer to those owners. Risk: ordinary client regression risk; focused command above.

- **KEEP** `escapes quoted keys and keeps root paths usable` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(jsonChildren({ 'q"x': 1 }, "input"), [`; `assert.deepEqual(jsonChildren({ items: 2 }, ""), [{ key: "items", path: "items", value: 2 }]);`; `assert.deepEqual(jsonChildren([3], ""), [{ key: 0, path: "[0]", value: 3 }]);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `pages children with their paths` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(page.length, 100);`; `assert.deepEqual(page[0], { key: 100, path: "out[100]", value: 100 });`; `assert.equal(jsonChildren(list, "out", 200, 100).length, 50);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `copies strings raw and preserves JSON values` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(jsonCopyText("raw text"), "raw text");`; `assert.deepEqual(JSON.parse(jsonCopyText({ a: [1] })), { a: [1] });`; `assert.equal(jsonCopyText(undefined), "");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.

## packages/ui/src/lib/workflows/notifications.test.ts

B1: Workflow spec §5.11 failures by default, optional success, deduplication, Attention Center clearing and view navigation; package index exports the pure notification API.

B4/B5 and non-test callers: notifications.ts; app event router, WorkflowsHost/AttentionCenter and mounted run views consume it. Tests observe resulting data/state, not helper calls or component structure.

B2/B3 case oracle family: Fixed finished-run identities/settings produce notification data or silence; hidden pages must not swallow failure, live viewing cannot suppress a future failure, and connection resets clear remembered identity. Rule cases uniquely cover status mapping, payload details, subrun/test suppression; store cases cover delivery/lifecycle/source selection.

B6/remaining stronger coverage: daemon/API tests own execution, shared graph validity, expression evaluation and persisted schemas; these cases own the client transformation/navigation/cache and do not replay execution. Deleted duplicate cases below defer to those owners. Risk: ordinary client regression risk; focused command above.

- **KEEP** `reads notify settings field-wise, defaulting to failures only` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(notifyPrefsOf(undefined), { onFailure: true, onSuccess: false });`; `assert.deepEqual(notifyPrefsOf({ notify: { onFailure: false, onSuccess: true } }), {`; `assert.deepEqual(notifyPrefsOf({ notify: { onSuccess: "yes" } } as never), { onFailure: true, onSuccess: false });` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `counts a Stop block's end as a success and a cancel or a skip as nothing` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(runOutcomeKind("failed"), "failure");`; `assert.equal(runOutcomeKind("interrupted"), "failure");`; `assert.equal(runOutcomeKind("succeeded"), "success");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `preserves the failure's error, project and test-run identity in its toast` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(failed?.tone, "danger");`; `assert.match(failed!.message, /every account is out of usage/);`; `assert.equal(failed?.projectPath, "/w/acme/app");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `says nothing about a sub-workflow's run` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(finishedRunNotice(run({ parentRunId: "p" }), { prefs: DEFAULT_NOTIFY_PREFS }), null);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `puts failed runs in the Attention Center, never test runs` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(entry, {`; `assert.equal(attentionEntryFor(run({ test: true }), { prefs: DEFAULT_NOTIFY_PREFS }), null);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `raises a toast and an entry once per run, however often the event arrives` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(state().toasts.length, 1);`; `assert.equal(state().attention.length, 1);`; `assert.equal(state().toasts.length, 1);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `stays quiet for the run the user is looking at` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(state(), { toasts: [], attention: [] });` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `a mounted run in a hidden document does not swallow the failure` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(state().attention[0]?.runId, "run-2");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `viewing a LIVE run never silences its later failure` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(state().attention.some((entry) => entry.runId === "run-live"), true);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `the workflow summary's notify settings decide (a success toast when asked, no failure when off)` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(state().toasts.length, 0);`; `assert.equal(state().attention.length, 0);`; `assert.equal(state().toasts[0]?.runId, "s");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `clears a run's toast and entry once it is viewed, and stays quiet about it after` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(`; `assert.deepEqual(`; `assert.equal(` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `dismisses the toasts and one entry at a time` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(`; `assert.equal(state().toasts.length, 0);`; `assert.equal(state().attention.length, 2);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `reads the workflow's notify settings from a loaded run's definition` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(state().toasts[0]?.runId, "run-9");`; `assert.equal(state().toasts[0]?.tone, "ok");`; `assert.equal(state().attention.length, 0);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `forgets everything on a connection switch` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(state(), { toasts: [], attention: [] });`; `assert.equal(state().toasts.length, 1);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.

## packages/ui/src/lib/workflows/open-bridge.test.ts

B1: Workflow spec §5.10 workflow session chip opens its owning run; AGENTS.md validates bridge data.

B4/B5 and non-test callers: open-bridge.ts; chat ownership chip and mounted workflow host subscribe/open. Tests observe resulting data/state, not helper calls or component structure.

B2/B3 case oracle family: The published run target reaches registered consumers only until unsubscribe, returns false without a consumer, and malformed or non-chat owners never navigate.

B6/remaining stronger coverage: daemon/API tests own execution, shared graph validity, expression evaluation and persisted schemas; these cases own the client transformation/navigation/cache and do not replay execution. Deleted duplicate cases below defer to those owners. Risk: ordinary client regression risk; focused command above.

- **KEEP** `every listener takes the run, and unsubscribing takes it out` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(openWorkflowRun(target), true);`; `assert.deepEqual(a, [target]);`; `assert.deepEqual(b, [target]);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **DELETE** `a listener that unsubscribes while being called does not skip the others` — Listener-set implementation exercise: removing the currently visited Set entry does not skip the next with either native iteration or copied iteration. Regular subscribe/deliver/unsubscribe contract remains; no distinct credible failure (bar 6).
- **KEEP** `only a chat tab with a whole workflow owner links to a run` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(workflowRunTargetOf({ kind: "agent-chat", owner }), target);`; `assert.equal(workflowRunTargetOf({ kind: "agent-chat" }), null);`; `assert.equal(workflowRunTargetOf({ kind: "shell", owner }), null);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.

## packages/ui/src/lib/workflows/overlay.test.ts

B1: Workflow spec §7.3 run state overlay on frozen definition and §3.4 success/error path semantics.

B4/B5 and non-test callers: overlay.ts; canvas/Steps display the resulting run overlay. Tests observe resulting data/state, not helper calls or component structure.

B2/B3 case oracle family: Literal block timings, attempt/current account and edge states identify live/dead paths even before edge deltas arrive; recorded edge decisions override fallback inference.

B6/remaining stronger coverage: daemon/API tests own execution, shared graph validity, expression evaluation and persisted schemas; these cases own the client transformation/navigation/cache and do not replay execution. Deleted duplicate cases below defer to those owners. Risk: ordinary client regression risk; focused command above.

- **KEEP** `per block: status, duration (live for a running one), attempt, handle, account and hops` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(overlay.runStatus, "running");`; `assert.equal(overlay.nodes.t?.durationMs, 1500);`; `assert.equal(overlay.nodes.a?.durationMs, 8 * 60_000);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `edges: taken, active into a running block, dead, idle — read off the source when the lists lag` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(overlay.edges["t-success-i"], "taken");`; `assert.equal(overlay.edges["i-true-a"], "active", "taken (by the handle) and its target runs");`; `assert.equal(overlay.edges["i-false-b"], "dead", "the other handle of a finished block");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `a failed block takes its error edge unless the run records another path` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(overlay.edges["a-success-s"], "dead");`; `assert.equal(overlay.edges["a-err-s"], "taken");`; `assert.equal(overlay.nodes.a?.errorMessage, "Boom");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.

## packages/ui/src/lib/workflows/process-settings.test.ts

B1: Workflow spec §7.2 HTTP/Shell forms and §3.3 templated values; HTTP code/header grammar; AGENTS.md unknown-field preservation and secrets kept as references. Shell helper protects process environment namespace and script data/code separation.

B4/B5 and non-test callers: process-settings.ts; ProcessSettings.tsx calls body/status parsers, warnings and planShellEnvVariables. Tests observe resulting data/state, not helper calls or component structure.

B2/B3 case oracle family: Literal body/status data must survive re-selection, parsers distinguish known valid/invalid inputs, shell rows preserve expressions/unknown fields without taking shell-sensitive names, collisions or overwritten variables. Warnings assert error/warning state, not English copy.

B6/remaining stronger coverage: daemon/API tests own execution, shared graph validity, expression evaluation and persisted schemas; these cases own the client transformation/navigation/cache and do not replay execution. Deleted duplicate cases below defer to those owners. Risk: ordinary client regression risk; focused command above.

- **DELETE** `writes memory in GB when it is a round number of them` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `picks the timeout the daemon applies: the block's own, then the block-wide one, then the default` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `summarises a code block's limits` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `summarises a shell block's timeout` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `says the request in one line with its row counts` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `says what body is sent, and that GET / HEAD send none` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `says what counts as success, redirects and the timeout` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **REWRITE** `leaves the config untouched when the kind is already chosen` — Retains the named data/protocol contract; removes exact prose, object-identity or private helper expectations and observes preserved data/state through the production seam.
  - Final B2/B3 witness after rewrite: `assert.deepEqual(httpConfigWithBodyKind(form, "form"), form, "re-picking Form keeps its fields")`; `assert.deepEqual(httpConfigWithBodyKind(text, "text"), text, "re-picking Text keeps its content type")` Fixed data and state are the oracle; removed private identity/prose assertions are not retention requirements.
- **REWRITE** `carries a written value across, and starts JSON as an empty object` — Retains the named data/protocol contract; removes exact prose, object-identity or private helper expectations and observes preserved data/state through the production seam.
  - Final B2/B3 witness after rewrite: `assert.deepEqual(httpConfigWithBodyKind(text, "json").body, { kind: "json", value: "hi" })`; `assert.deepEqual(httpConfigWithBodyKind(text, "form").body, { kind: "form", fields: [] })`; `assert.equal("body" in httpConfigWithBodyKind(text, "none"), false)` Fixed data and state are the oracle; removed private identity/prose assertions are not retention requirements.
- **REWRITE** `keeps the success statuses when their mode is re-picked, and restores the latest list` — Retains the named data/protocol contract; removes exact prose, object-identity or private helper expectations and observes preserved data/state through the production seam.
  - Final B2/B3 witness after rewrite: `assert.deepEqual(successStatusesForMode(list, "list", [201]), list, "re-picking the list keeps edits")`; `assert.equal(successStatusesForMode("2xx", "2xx", [201]), "2xx")`; `assert.equal(successStatusesForMode(list, "2xx", list), "2xx")` Fixed data and state are the oracle; removed private identity/prose assertions are not retention requirements.
- **KEEP** `reads codes separated by commas, semicolons or spaces, once each, in order` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(parseStatusList("200, 201 404;200"), { statuses: [200, 201, 404], invalid: [] });`; `assert.deepEqual(parseStatusList(" "), { statuses: [], invalid: [] });` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **REWRITE** `names what isn't a status code` — Retains the named data/protocol contract; removes exact prose, object-identity or private helper expectations and observes preserved data/state through the production seam.
  - Final B2/B3 witness after rewrite: `assert.deepEqual(parseStatusList("200, 2xx, 99, 600, 4"), { statuses: [200], invalid: ["2xx", "99", "600", "4"] })`; `assert.ok(statusListProblem("200, abc"))`; `assert.ok(statusListProblem("20, 30"))` Fixed data and state are the oracle; removed private identity/prose assertions are not retention requirements.
- **KEEP** `accepts JSON, with expressions standing in for values or inside strings` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(jsonBodyProblem('{ "a": 1 }'), null);`; `assert.equal(jsonBodyProblem('{ "text": {{ nodes.Review.output.text | json }} }'), null);`; `assert.equal(jsonBodyProblem('{ "id": "{{ input.id }}", "n": {{ input.n }} }'), null);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `accepts exactly one expression: its value is encoded as JSON` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(jsonBodyProblem("{{ input }}"), null);`; `assert.equal(jsonBodyProblem("  {{ nodes.Fetch.output.body }}\n"), null);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **REWRITE** `names a body that won't parse, without positions into the stand-in text` — Retains the named data/protocol contract; removes exact prose, object-identity or private helper expectations and observes preserved data/state through the production seam.
  - Final B2/B3 witness after rewrite: `assert.ok(problem)`; `assert.ok(!/position/.test(problem!), problem!)`; `assert.ok(jsonBodyProblem("{ a: 1 }") !== null)` Fixed data and state are the oracle; removed private identity/prose assertions are not retention requirements.
- **KEEP** `leaves a broken expression to the validator` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(jsonBodyProblem('{ "a": {{ input. }} }'), null);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `plans one row per distinct expression and never touches the script` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(plan.variables, [`; `assert.deepEqual(plan.env, [`; `assert.equal(plan.incomplete, false);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **DELETE** `names variables after what they read` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **KEEP** `never suggests a name the shell, the loader or a common tool reads` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(names(\`echo "${expression}"\`), [expected], expression);`; `assert.equal(isReservedEnvName(expected), false, expected);`; `assert.equal(isReservedEnvName("http_proxy"), true, "a lowercase proxy name counts too");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `never takes a name a row or a word of the script already uses` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(names("echo {{ input.text }}", [{ name: "INPUT_TEXT", value: "other" }]), ["INPUT_TEXT_2"]);`; `assert.deepEqual(names('VERSION=1.0; echo "{{ nodes.Version.output }}" "$VERSION"'), ["VERSION_2"]);`; `assert.deepEqual(names("for INPUT_A in 1; do echo {{ input.a }}; done"), ["INPUT_A_2"]);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `reuses a row only when it holds exactly that expression and wins at run time` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(planShellEnvVariables("echo {{input.a}}", [{ name: "A", value: "{{ input.a }}" }]).variables, [`; `assert.deepEqual(names("echo {{ input.a }}", [{ name: "A", value: " {{ input.a }}" }]), ["INPUT_A"], "surrounding spaces are part of its value");`; `assert.deepEqual(names("echo {{ input.a }}", [{ name: "A", value: "x{{ input.a }}" }]), ["INPUT_A"], "surrounding text");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `doesn't reuse a row the script itself sets or reads other than as $NAME` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(names('A=x; echo "$A" {{ input.a }}', row), ["INPUT_A"]);`; `assert.deepEqual(names("read A; echo {{ input.a }}", row), ["INPUT_A"]);`; `assert.deepEqual(names("declare -n A=B; echo {{ input.a }}", row), ["INPUT_A"]);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **REWRITE** `keeps every row as it was, fields a newer version wrote included` — Retains the named data/protocol contract; removes exact prose, object-identity or private helper expectations and observes preserved data/state through the production seam.
  - Final B2/B3 witness after rewrite: `assert.deepEqual(plan.env, [ { name: "KEEP", value: "1", note: "kept" }, { name: "A", value: "{{ input.a }}", secret: true }, { name: "INPUT_B", value: "{{ input.b }}" } ])` Fixed data and state are the oracle; removed private identity/prose assertions are not retention requirements.
- **KEEP** `adds nothing the second time, also once the script reads the variables` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(first.variables.map((variable) => variable.name), ["INPUT_A", "WF_PATH"]);`; `assert.deepEqual(second.env, first.env);`; `assert.deepEqual(second.variables.map((variable) => [variable.name, variable.added]), [` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `leaves Go-style {{.Field}} alone and notes a broken expression` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(names("gh pr list --template '{{.title}}' --repo {{ input.repo }}"), ["INPUT_REPO"]);`; `assert.deepEqual(broken.variables, []);`; `assert.equal(broken.incomplete, true);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **REWRITE** `flags environment names the shell block fails on, and repeats` — Retains the named data/protocol contract; removes exact prose, object-identity or private helper expectations and observes preserved data/state through the production seam.
  - Final B2/B3 witness after rewrite: `assert.ok(envRowProblem(rows, 0).warning)`; `assert.ok(envRowProblem(rows, 1).error)`; `assert.equal(envRowProblem(rows, 2).error, null)` Fixed data and state are the oracle; removed private identity/prose assertions are not retention requirements.
- **REWRITE** `flags header names the HTTP block fails on and nameless rows it skips` — Retains the named data/protocol contract; removes exact prose, object-identity or private helper expectations and observes preserved data/state through the production seam.
  - Final B2/B3 witness after rewrite: `assert.deepEqual(requestRowProblem(rows, 0, "header"), { error: null, warning: null })`; `assert.ok(requestRowProblem(rows, 1, "header").error)`; `assert.deepEqual(requestRowProblem(rows, 1, "query"), { error: null, warning: null }, "a query name may hold spaces")` Fixed data and state are the oracle; removed private identity/prose assertions are not retention requirements.

## packages/ui/src/lib/workflows/run-behaviour.test.ts

B1: Legacy workflow config has block timeout minutes and per-type timeout minutes/seconds; daemon run-context caps the effective value. Migration must preserve the effective limit.

B4/B5 and non-test callers: run-behaviour.ts; CommonSettings invokes movedTimeoutPatch. Tests observe resulting data/state, not helper calls or component structure.

B2/B3 case oracle family: 10 minutes stays 10 for code, two minutes becomes 120 seconds for HTTP, values cap at independent schema maxima, and unsupported/missing fields produce no patch.

B6/remaining stronger coverage: daemon/API tests own execution, shared graph validity, expression evaluation and persisted schemas; these cases own the client transformation/navigation/cache and do not replay execution. Deleted duplicate cases below defer to those owners. Risk: ordinary client regression risk; focused command above.

- **DELETE** `Run workflow: the block-level limit is the one to edit, set or not` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `nothing to show when no block-level limit is set on any other type` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `Code / Shell: the block-level value is in effect until Limits has its own` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `HTTP: its own seconds win; the default is 5 min` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `Agent, flow blocks, Wait and triggers never read it` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **KEEP** `moves the value as the daemon applies it, capped at the type's maximum` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(movedTimeoutPatch(node("c", "code", {}, { timeoutMinutes: 10 })), { timeoutMinutes: 10 });`; `assert.deepEqual(movedTimeoutPatch(node("c", "shell", {}, { timeoutMinutes: 5000 })), { timeoutMinutes: 1440 });`; `assert.deepEqual(movedTimeoutPatch(node("h", "http", {}, { timeoutMinutes: 2 })), { timeoutSeconds: 120 });` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `has nothing to move for other types or without a value` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(movedTimeoutPatch(node("a", "agent", {}, { timeoutMinutes: 10 })), null);`; `assert.equal(movedTimeoutPatch(node("c", "code")), null);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **DELETE** `reads the retry setting in words` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `summarises an executable block` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `summarises a trigger: on or off, and notes` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `ignores blank notes` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `only blocks that work in a project folder take another project` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `names a project by its folder` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.

## packages/ui/src/lib/workflows/run-view.test.ts

B1: Workflow spec §7.3 timeline, statuses, input/output/retry/filter UI; §3.2 live input semantics; API RunWorkflowRequest retryOf/fromNodeId/test/input fields.

B4/B5 and non-test callers: run-view.ts; RunsMode/RunView/StepDetail read these output models. Tests observe resulting data/state, not helper calls or component structure.

B2/B3 case oracle family: Fixed run/block records supply actual errors/timing/current account; unreached vs pending differs for finished/live runs; selected branch inputs and merged names remain accurate; retry request preserves original event/input/test identity even before full detail loads; history pages preserve live status.

B6/remaining stronger coverage: daemon/API tests own execution, shared graph validity, expression evaluation and persisted schemas; these cases own the client transformation/navigation/cache and do not replay execution. Deleted duplicate cases below defer to those owners. Risk: ordinary client regression risk; focused command above.

- **KEEP** `preserves failed block details and distinguishes unreached steps in a finished run` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(byId("Build").attempt, 2);`; `assert.equal(byId("Build").durationMs, 60_000);`; `assert.equal(byId("Alert").error, "503 Service Unavailable");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `shows a working agent's account, hops and activity` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(deploy.account, "claude/b");`; `assert.equal(deploy.hopCount, 1);`; `assert.equal(deploy.liveLine, "Editing src/app.ts");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `builds a block's input from its live upstreams` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(blockInput(run, workflow, "Start"), {`; `assert.deepEqual(blockInput(run, workflow, "Build").value, { kind: "manual", input: { ticket: "APP-1" } });`; `assert.equal(blockInput(run, workflow, "Deploy").kind, "single");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `merges several live inputs by name` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(input.kind, "merge");`; `assert.deepEqual(input.value, { A: 1, B: 2 });`; `assert.equal(input.truncated, true);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `offers what makes sense now` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(runActions(summary({ status: "running" }), {}), {`; `assert.deepEqual(runActions(failed, { a: block("a", { status: "failed" }) }), {`; `assert.equal(runActions(failed, { a: block("a") }).retryFromFailed, false);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `retries with the same input, or from the same event` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(retryRunRequest(manual, { kind: "manual", input: { ticket: "APP-1" } }), {`; `assert.deepEqual(`; `assert.deepEqual(retryRunRequest(manual, null), {});` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `filters by status and counts each filter` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(`; `assert.deepEqual(`; `assert.deepEqual(` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `merges the live page with older pages, the live copy winning, newest first` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.

## packages/ui/src/lib/workflows/runs-mode.test.ts

B1: Workflow spec §7.3 selected run and detail view; §5.11 external run navigation must respect an explicit run id.

B4/B5 and non-test callers: runs-mode.ts; RunsMode.tsx uses pickRunId/pickBlockId. Tests observe resulting data/state, not helper calls or component structure.

B2/B3 case oracle family: Explicit older run/block selection wins over automatic active/failed defaults; absent choices fall back without returning a removed block.

B6/remaining stronger coverage: daemon/API tests own execution, shared graph validity, expression evaluation and persisted schemas; these cases own the client transformation/navigation/cache and do not replay execution. Deleted duplicate cases below defer to those owners. Risk: ordinary client regression risk; focused command above.

- **KEEP** `shows the run asked for, else the newest live one, else the newest` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(pickRunId("old", runs), "old", "an older run than the page holds");`; `assert.equal(pickRunId(null, runs), "r2");`; `assert.equal(pickRunId(null, [runs[0]!, runs[2]!]), "r3");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `keeps the picked block while the run has it; else the run's own default` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(pickBlockId(items, "b"), "b");`; `assert.equal(pickBlockId(items, "gone"), "a", "the failed block");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.

## packages/ui/src/lib/workflows/store.test.ts

B1: Workflow spec §8.1 tolerant workflow event cache, idempotent events and stale-on-reconnect; §7.1 list/actions; AGENTS.md bridge payload validation and connection isolation.

B4/B5 and non-test callers: store.ts and sanitize.ts; app event router, workflow hooks and rail actions use these APIs. Tests observe resulting data/state, not helper calls or component structure.

B2/B3 case oracle family: Literal malformed wire fixtures repair/drop fields; actual store actions keep newer deltas/revisions and tombstones, maintain error/optimistic state, invalidate correct secret scopes and reject old-connection replies. Fake API data never implements these cache/lifecycle policies.

B6/remaining stronger coverage: daemon/API tests own execution, shared graph validity, expression evaluation and persisted schemas; these cases own the client transformation/navigation/cache and do not replay execution. Deleted duplicate cases below defer to those owners. Risk: ordinary client regression risk; focused command above.

- **KEEP** `drops a row with no id or name, and repairs the rest field by field` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(sanitizeWorkflowSummary({ name: "x" }), null);`; `assert.equal(sanitizeWorkflowSummary({ id: "a" }), null);`; `assert.ok(repaired);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `keeps the listed errors and what they leave out` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(row?.errorCount, 7);`; `assert.deepEqual(row?.errors, [opus]);`; `assert.equal(row?.errorsOmitted, 6);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `an older daemon's row (the count alone) has no list` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(row?.errorCount, 1);`; `assert.equal(row && "errors" in row, false);`; `assert.equal(row && "errorsOmitted" in row, false);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `repairs a malformed list entry by entry, and never counts fewer errors than it lists` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(row?.errorCount, 2);`; `assert.deepEqual(row?.errors, [opus, { severity: "error", code: "", message: "Second" }]);`; `assert.equal(row && "errorsOmitted" in row, false);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **DELETE** `caps the list` — Fixed five-row sanitizer cap duplicates the shared summary cap and snapshots an internal truncation choice; malformed entries/count compatibility remain (bars 1/6).
- **KEEP** `loads once, shares a request in flight, and refreshes when stale` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(api.listCalls, 1);`; `assert.equal(state().load.status, "loaded");`; `assert.deepEqual([...state().summaries.keys()].sort(), ["a", "b"]);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `a failure is the error state, and a refresh failure keeps the rows` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(state().load.status, "error");`; `assert.ok(state().load.error);`; `assert.equal(state().load.status, "loaded");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `an event that crosses the answer is not undone by it` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(state().summaries.get("a")?.name, "New", "the newer revision stands");`; `assert.equal(state().summaries.has("b"), false, "a deleted id never comes back");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `a client of another connection resets first` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual([...state().summaries.keys()], ["z"]);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `ignores malformed payloads and unknown types without a throw` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.doesNotThrow(() => {`; `assert.equal(state().summaries.size, 0);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `repeated events neither duplicate rows nor resurrect deleted workflows` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(state().summaries.get("a")?.name, "Nightly");`; `assert.equal(state().summaries.size, 1);`; `assert.equal(state().summaries.has("a"), false, "a tombstoned id is never re-added");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `a run's start, updates and end fold into its workflow's row` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(state().summaries.get("a")?.activeRuns.map((r) => r.id), ["r1"]);`; `assert.equal(state().summaries.get("a")?.lastRun?.id, "r1");`; `assert.equal(entry?.blocks.n2?.status, "running");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `a secrets change marks the scopes it touches stale` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(state().secrets[workflowSecretsKey("a")]?.stale, true);`; `assert.equal(state().secrets[workflowSecretsKey("b")]?.stale, false);`; `assert.equal(state().secrets[workflowSecretsKey(null)]?.stale, false);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `block updates accept a retry but ignore an earlier attempt or state` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(state().runs.r?.blocks.n?.status, "succeeded");`; `assert.equal(state().runs.r?.blocks.n?.status, "running");`; `assert.equal(state().runs.r?.blocks.n?.attempt, 2);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `a workflow's recent runs load newest first, and a started run joins them` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(state().recentRuns.a?.runs.map((r) => r.id), ["new", "old"]);`; `assert.deepEqual(state().recentRuns.a?.runs.map((r) => r.id), ["live", "new", "old"]);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `a loaded run keeps the deltas that landed while it was in flight` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.ok(entry?.detail, "the whole run is held");`; `assert.equal(entry.blocks.n1?.status, "succeeded", "the delta further along stands");`; `assert.equal(entry.blocks.n2?.status, "pending");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `a reconnect marks a held run stale; a forced reload clears it and takes the run's end` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(state().runs.r3?.summary.status, "running");`; `assert.equal(state().runs.r3?.stale, true);`; `assert.equal(state().runs.r3?.stale, false);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `a list refresh updates the summary of a run held whole` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(state().runs.r4?.summary.status, "succeeded");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **REWRITE** `a run whose definition does not parse is an error, not a crash` — Keep rejection of malformed wire definitions at the public load/store boundary; remove the assertion through `workflowRunLoadError`, whose only caller is this test. Rename the case to describe the observable contract: invalid data is not published and loading does not crash. B1: AGENTS.md requires validating bridge payloads before shared UI state. B2/B3: the literal `{ nope: true }` definition must leave run `r2` absent after a resolved load. B4/B5: public loader and store state survive internal error-cache refactors. B6: this uniquely exercises whole-run response validation, rather than event/list repair.
  - Final B2/B3 witness after rewrite: `assert.doesNotReject(loadWorkflowRun(api, "r2"))`; `assert.equal(state().runs.r2, undefined)` Fixed data and state are the oracle; removed private identity/prose assertions are not retention requirements.
- **KEEP** `enabling shows at once, then carries the daemon's answer` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(state().enabledOverrides.get("a"), true);`; `assert.equal(shown.enabled, true);`; `assert.equal(result.ok, true);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `a refusal rolls back and becomes the notice; a stale revision is re-read once` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(retried.ok, true);`; `assert.equal(api.patches[1]?.req.revision, 7, "the retry sends the revision it re-read");`; `assert.equal(refused.ok, false);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `an overlap skip offers Run anyway` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(state().notice?.action, "run-anyway");`; `assert.equal(state().notice?.workflowId, "a");`; `assert.deepEqual(api.runs[1]?.req, { force: true });` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `create shows the row at once; delete removes it, and a gone workflow counts as deleted` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(created.ok, true);`; `assert.equal(row?.name, "Fresh");`; `assert.equal(deleted.ok, true);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `a write's own row lists the errors its answer carries` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(row?.errorCount, 1);`; `assert.deepEqual(row?.errors, [`; `assert.equal(row && "errorsOmitted" in row, false);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `a reset drops answers still in flight` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(state().summaries.size, 0);`; `assert.equal(state().load.status, "idle");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.

## packages/ui/src/lib/workflows/temp-projects.test.ts

B1: Workflow spec §5.10 marks actual temporary run projects; unrelated user projects are not run-owned.

B4/B5 and non-test callers: temp-projects.ts; sidebar project rendering consumes known run paths. Tests observe resulting data/state, not helper calls or component structure.

B2/B3 case oracle family: Exact known nondeleted path is recognized with trailing-slash normalization; deleted and merely wf-prefixed user projects remain unmarked.

B6/remaining stronger coverage: daemon/API tests own execution, shared graph validity, expression evaluation and persisted schemas; these cases own the client transformation/navigation/cache and do not replay execution. Deleted duplicate cases below defer to those owners. Risk: ordinary client regression risk; focused command above.

- **KEEP** `marks a project a known run names as its temp project` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(isWorkflowTempProject({ path: "/w/ws/wf-nightly-aaaaaaaa", name: "wf-nightly-aaaaaaaa" }, known), true);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **KEEP** `never a deleted one, and never a wf- folder on its name alone` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(isWorkflowTempProject({ path: "/w/ws/wf-old-bbbbbbbb", name: "wf-old-bbbbbbbb" }, known), false);`; `assert.equal(isWorkflowTempProject({ path: "/w/ws/wf-mine-12345678", name: "wf-mine-12345678" }, known), false);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **DELETE** `the name fallback counts when a known run's id confirms it` — Eight-character name inference is an implementation heuristic rather than independent ownership evidence. Exact run path/deleted/unrelated-path cases retain actual ownership contract (bar 1).

## packages/ui/src/lib/workflows/trigger-text.test.ts

B1: Workflow spec §6.1 cron schedules and §7.2 editable JSON/config fields; AGENTS.md unknown-field preservation and current schema trigger discriminated unions.

B4/B5 and non-test callers: trigger-text.ts; TriggerSettings.tsx invokes conversion/validation/config edits. Tests observe resulting data/state, not helper calls or component structure.

B2/B3 case oracle family: Last-day cron executes on Jan 31 and Feb 28; example JSON accepts valid/empty data and reports real malformed location; re-selection and edits preserve authored times, URLs, accounts, event fields and unknown fields.

B6/remaining stronger coverage: daemon/API tests own execution, shared graph validity, expression evaluation and persisted schemas; these cases own the client transformation/navigation/cache and do not replay execution. Deleted duplicate cases below defer to those owners. Risk: ordinary client regression risk; focused command above.

- **DELETE** `reads a cron in words, or null` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `heads with the preset's words while the cron matches it, else the cron's` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `summarises with the zone except for every-N-minutes` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `labels a zone's offset, none for UTC or an unknown zone` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `explains monthly days 29–31 the way the cron actually fires` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **KEEP** `builds a last-day-of-month cron the scheduler accepts` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(cron, "30 9 L * *");`; `assert.equal(validateCron(cron, "UTC"), null);`; `assert.deepEqual(` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **DELETE** `lists an hourly schedule's first times from midnight` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `offers every weekday once, Monday first, and quick picks by set` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `names every pull-request action` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `says each event in words` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `says which repository and with which access` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `states the poller's cadence per event` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **DELETE** `splits a comma list` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **KEEP** `accepts empty or valid JSON` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.equal(jsonExampleProblem(""), null);`; `assert.equal(jsonExampleProblem("  \n"), null);`; `assert.equal(jsonExampleProblem('{ "a": 1 }'), null);` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **REWRITE** `points at the line and column of a mistake` — Retains the named data/protocol contract; removes exact prose, object-identity or private helper expectations and observes preserved data/state through the production seam.
  - Final B2/B3 witness after rewrite: `assert.ok(problem !== null)`; `assert.match(problem!, /line 3, column 3/)`; `assert.ok(!/position \d/.test(problem!), "the raw position is replaced by line and column")` Fixed data and state are the oracle; removed private identity/prose assertions are not retention requirements.
- **DELETE** `formats valid JSON with two-space indents, null otherwise` — No independently fixed wording/markup/private-helper contract; behavior-preserving presentation or implementation changes can break it (bars 1/4/5). Existing production behavior is unchanged.
- **REWRITE** `re-picking the current schedule kind changes nothing` — Retains the named data/protocol contract; removes exact prose, object-identity or private helper expectations and observes preserved data/state through the production seam.
  - Final B2/B3 witness after rewrite: `assert.deepEqual(presetForKind(stored.kind, stored), stored, \`${preset.kind} is kept as is\`)` Fixed data and state are the oracle; removed private identity/prose assertions are not retention requirements.
- **REWRITE** `switching the schedule kind starts it fresh, keeping the time of day` — Retains the named data/protocol contract; removes exact prose, object-identity or private helper expectations and observes preserved data/state through the production seam.
  - Final B2/B3 witness after rewrite: `assert.deepEqual(presetForKind("weekly", { kind: "daily", time: "07:30" }), { kind: "weekly", days: [1, 2, 3, 4, 5], time: "07:30" })`; `assert.deepEqual(presetForKind("monthly", { kind: "weekly", days: [1], time: "18:00" }), { kind: "monthly", day: 1, time: "18:00" })`; `assert.deepEqual(presetForKind("cron", { kind: "daily", time: "07:30" }), { kind: "cron" })` Fixed data and state are the oracle; removed private identity/prose assertions are not retention requirements.
- **REWRITE** `re-picking the current repository kind keeps the URL and account` — Retains the named data/protocol contract; removes exact prose, object-identity or private helper expectations and observes preserved data/state through the production seam.
  - Final B2/B3 witness after rewrite: `assert.deepEqual(repoForKind("url", url), url)`; `assert.deepEqual(repoForKind("project", project), project)`; `assert.deepEqual(repoForKind("project", url), { kind: "project" })` Fixed data and state are the oracle; removed private identity/prose assertions are not retention requirements.
- **KEEP** `changing the account keeps every other repository field` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(repoWithAccount(url, "a2"), { kind: "url", url: "git@github.com:acme/app.git", accountId: "a2", futureField: { keep: true } });`; `assert.deepEqual(publicRepo, { kind: "url", url: "git@github.com:acme/app.git", futureField: { keep: true } });`; `assert.ok(!("accountId" in publicRepo), "public = no accountId key at all");` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.
- **REWRITE** `re-picking the current event kind changes nothing` — Retains the named data/protocol contract; removes exact prose, object-identity or private helper expectations and observes preserved data/state through the production seam.
  - Final B2/B3 witness after rewrite: `assert.deepEqual(eventForKind(stored.kind, stored), stored, \`${event.kind} is kept as is\`)`; `assert.deepEqual(eventForKind("tag", { kind: "push", branches: ["main"] }), { kind: "tag", pattern: "v*" })`; `assert.deepEqual(eventForKind("pull_request", { kind: "tag" }), { kind: "pull_request", actions: ["opened", "updated"] })` Fixed data and state are the oracle; removed private identity/prose assertions are not retention requirements.
- **KEEP** `edits within an event keep its other fields` — Protects the named contract with the fixed fixture oracle below; unique client owner described above.
  - B2/B3 witness: `assert.deepEqual(tagWithPattern(tag, "release-*"), { kind: "tag", pattern: "release-*", futureField: { keep: true } });`; `assert.deepEqual(anyTag, { kind: "tag", futureField: { keep: true } });`; `assert.ok(!("pattern" in anyTag));` Data values come from the fixed requirement/fixture, not a call to the owner to calculate an expectation.

Pre-edit follow-up seam audit: global `rg --text` including desktop and web found `workflowRunLoadError` only in its declaration and this one test; its `runLoadErrors` map is otherwise write-only. Remove the wrapper, map and writes while retaining observable malformed-response rejection. `SecretPicker`, `RUN_TONE_DOT` and `RunStatusDot` have only same-module production callers: internalize their exports.

Pre-edit dead-support follow-up: global text searches show `plainGuideText` (`guide-text.ts`) and `strategyName` (`agent-policy-text.ts`) have no remaining callers in production, tests, desktop or web. Their only consumers were the deleted guide/copy checks. Delete both unused wrappers; runtime guide spans and policy summaries use their existing owners directly.

Pre-edit export follow-up: `WINDOW_WORDS`, `strategyText`, `limitParts`, `skipReasonText` and `BLOCK_OUTPUT_GUIDE_TITLES` have only same-module production consumers after removal of copy/inventory tests; no package barrel re-exports their modules. Make these implementation details private. `fieldCovered` and `countProblems` remain exported because trigger/chain forms consume them.


## Completed changes and verification

All 303 original named test declarations reconcile to the final tree: **101 DELETE, 21 REWRITE, 181 KEEP**. The 8 assigned check scripts were deleted with every substantive scenario listed above. Eleven complete files are gone (8 checks, 3 test files); 31 test files and 202 cases remain. Test/check source falls from 7,116 to 3,636 lines, a net reduction of 3,480 lines. No tests were added.

Production/support cleanup after repository-wide reference searches:

- Removed `DataTabView`/`DataTabViewProps`, its injected run/output-reader/test-starter props, and fixed clock. The production `DataTab` now directly uses the same context, run hooks and API calls. Removed the now-unused fixed argument/branch from `useNow`.
- Removed `workflowRunLoadError`, its write-only `runLoadErrors` map and writes. Kept malformed whole-run rejection through public load/store state; error state for known runs remains intact.
- Removed the unused `plainGuideText`, `strategyName` and `markupText` wrappers, deleted inline SSR/hook-dispatcher fixture harnesses, and removed orphaned imports/fixtures from pruned tests.
- Internalized `modelFamily`, `resolveChainModel`, `resolveChainModels`; callers test request creation through `withLiveChainModels`.
- Internalized `withPromptText`, `withChatTitle`, `withContinueFrom`, `withMaxWaitHours`, `savedText`, `fitCardIds`, `movedCardIds`, `DecisionView`, `RulesGuide`, `ProblemBar`, `SecretPicker`, `CodeArgumentsHelp`, `CodeRuntimeHelp`, `RUN_TONE_DOT`, `RunStatusDot`, `problemCountText`, and `problemsHoverText`. Inlined the test-only `returnFocusToProblemsChip` predicate at its sole runtime caller without changing the condition.
- Internalized `WINDOW_WORDS`, `strategyText`, `limitParts`, `skipReasonText`, and `BLOCK_OUTPUT_GUIDE_TITLES`; their remaining callers are in the same source files.
- Removed LogViewer's static-check-only layout-effect fallback and stale static-check comments. Kept `WorkflowsPanelView`, `RunsList`, `RunHeader`, and `LogViewerView` composition: the actual parent UI passes the live clock, run/paging state, actions, and stream controls; they are real production consumers, not dormant injection hooks. `RunsMode` shares one timer across its panes, and `WorkflowsPanel` shares one across cards. Kept public package exports and real API dependencies.

Focused validation (package Node import hooks and `--test-concurrency=2`):

- All 31 remaining scope files: **202 passed, 0 failed** (`scope-5-focused.log`, 209.9 s).
- After removing the private error cache, `src/lib/workflows/store.test.ts`: **24 passed, 0 failed** (`scope-5-store-final.log`, 8.7 s); the final renamed malformed-definition case is present in this result.
- After dead guide/policy support removal, `src/lib/workflows/agent-policy-text.test.ts` and `src/lib/workflows/inspector-autocomplete.test.ts`: **16 passed, 0 failed** (`scope-5-support-final.log`).
- AST reconciliation found all expected 202 surviving declarations and no disposition mismatch. Final owned diffs and `git diff --check` reviewed clean. No baseline failures were observed before the interrupted baseline run; it was not rerun. Root owns the repository typecheck/test/build gates and remote integration.

API overlap was confirmed with the API owner: retained `validate.test.ts` cases `each integrity rule`, `cycles`, `switch handles follow its cases`, and `patch.test.ts` case `connect checks handles, inputs, self-loops and duplicates` cover the deleted duplicate graph-validity checks. No coverage-threshold/test-count conflict was encountered in focused validation.
