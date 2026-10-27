# Claude/OpenCode adapter audit

Scope: 36 current test files, 770 source test declarations (one parameterized declaration runs for two permission modes), 24,201 original test LOC. Review used provider fixture provenance/observations, the host module map and production interfaces, assertion/contract inventory across every declaration, and detailed body review for changed files and suspected duplication. The large lifecycle and replay suites received contract/assertion review; this is not a claim of exhaustive line-by-line verification of every implementation branch. Previous ledgers were discovery leads, not automatic KEEP decisions.

Outcome against original declarations: 761 KEEP, 1 REWRITE, 3 OPTIMIZE, 5 CONSOLIDATE records (2 surviving owners,3 absorbed executions),0 standalone DELETE. Final source declarations:767. No fixture, snapshot, helper, dependency or production seam becomes orphaned by these changes.

## How to read the six behavioral-bar requirements

For **every retained case below**, its file subsection supplies (1) the independent contract source; (4) the stable external/data boundary; (5) the behavior-preserving-refactor argument; and (6) the competing-owner analysis. The case title identifies (2) the concrete credible failure; the assertion excerpt supplies (3) the independent explicit expected outcome. Expectations are literals, captured external data, or preservation of independently supplied input—not results calculated by the function being checked. In a case with a shared assertion helper the table points to the case, whose helper checks the named public outcome. Test-local helper names/call counts and incidental DOM/markup are not the oracle.

For each file, boundary-preserving changes (renaming local identifiers, extracting helpers, reorganizing private implementation) leave the observed input/output contract unchanged; a deliberate change to public wire/permission/storage semantics is a contract change. Parser cases are retained where a more expensive lifecycle test lacks their malformed/ambiguous byte input. Lifecycle/integration cases survive where a pure parser cannot catch missing wiring, ordering, cleanup or concurrent-state behavior.

## Validation and performance

Central validation commands/results and comparable whole-suite timings are recorded by the root audit report. No agent test run overlapped the baseline. Planned focused command from apps/daemon: `TSX_DISABLE_CACHE=1 node --import tsx --test --test-concurrency=4 src/agent-host/adapters/claude/fork.test.ts src/agent-host/adapters/claude/history.test.ts src/agent-host/adapters/claude/local-process.test.ts src/agent-host/adapters/opencode/history.test.ts src/agent-host/adapters/opencode/snapshot-budget.test.ts`.

Baseline per-test body timings under the root concurrency4 run: Claude real-pipe case309.69ms; OpenCode cold snapshot166.97ms and separate warm scenario115.60ms; first three same-input history projections48.11/9.52/4.03ms. These values exclude file/compiler startup and are not added to claim wall-clock speedup. Final equivalent measurements belong to root final run.

Intentionally retained expensive cases: real Claude worker/OS pipe, real OpenCode process/health/auth/recycle integration, and the local Claude stderr-drain cap. These protect process/pipe contracts that scripted transports cannot verify. The existing real-Claude isolation suite is opt-in (`ORQUESTER_CLAUDE_LIVE=1`) and was not executed unless explicitly noted by root; it makes no model call. The OpenCode `deps.delay` hook remains used by surviving deterministic retry/reconnect race tests; removing it safely would require a separately validated native-clock conversion across nine workflows. No new production abstraction was added.

## Per-declaration dispositions

### `apps/daemon/src/agent-host/adapters/claude/classify.test.ts`

Independent source (1): GUI design §4.2–4.3; Claude protocol observations3–4; MCP tool-name grammar.
Stable seam (4) and refactor resistance (5): classifyToolItemType / classifyRequestType; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Prefix collisions and tool names absent from the real captures need the mapping owner; full fixture replay alone cannot cover these names.
Validation: focused Node/tsx command above with `src/agent-host/adapters/claude/classify.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| an MCP tool is an MCP call whatever words its name holds | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(classifyToolItemType("mcp__github__create_issue"), "mcp_tool_call")`. |
| the built-in tools keep their buckets | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(classifyToolItemType("Bash"), "command_execution")`. |

### `apps/daemon/src/agent-host/adapters/claude/config-dir.test.ts`

Independent source (1): Claude SDK CLAUDE_CONFIG_DIR account identity and host-home fallback.
Stable seam (4) and refactor resistance (5): claudeConfigDir; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): One shared resolution feeds probes, skill overlays and transcripts. Consumer-specific managed-home tests do not cover contradictory HOME overrides and absent settings together.
Validation: focused Node/tsx command above with `src/agent-host/adapters/claude/config-dir.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| is the child env's CLAUDE_CONFIG_DIR — a managed account's home | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal( claudeConfigDir({ CLAUDE_CONFIG_DIR: "/homes/acc-1/home", HOME: "/elsewhere" }), "/homes/acc-1/home" )`. |
| falls back to the host user's ~/.claude, never to a HOME the env names | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(claudeConfigDir({ HOME: "/somewhere/else" }), nodePath.join(homedir(), ".claude"))`. |

### `apps/daemon/src/agent-host/adapters/claude/fork.test.ts`

Independent source (1): Thread lineage design2026-10-14 §6; Claude observed native fork and inclusive UUID cuts.
Stable seam (4) and refactor resistance (5): forkClaudeConversation / ClaudeHistoryReader API; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Owns the external fork request and child resume identity; rollback planner tests do not perform this operation or its refusal-side-effect check.
Validation: focused Node/tsx command above with `src/agent-host/adapters/claude/fork.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| forks at the last message before the first removed turn | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(forks, [{ sessionId: "source-session", upToMessageId: "a2", cwd: "/work/project" }])`. |
| resolves a turn through the cursor's boundary pairs after a rewind re-minted the uuids | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(forks[0]!.upToMessageId, "y1")`. |
| copies the whole conversation when nothing is removed, up to a resume-at point | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(forks[0]!.upToMessageId, "a2")`. |
| refuses a turn the transcript cannot place, before any fork exists | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects( forkClaudeConversation({ history, cursor: { resume: "s" }, threadId: "child", cwd: "/w", firstRemovedTurnId: "unknown" }), /boundary is unavailable/ )`. |
| refuses an empty transcript | REWRITE | Keep the empty-history refusal and prove no fork operation ran. Replace the regex derived from the production error constant with an independent semantic refusal fragment. Shared production constant remains used by index.ts. |

### `apps/daemon/src/agent-host/adapters/claude/goal-transcript.test.ts`

Independent source (1): Goals design§6.1.4–5; Claude fixture observation23.
Stable seam (4) and refactor resistance (5): ClaudeGoalTranscript over temporary JSONL files; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Owns physical path lookup, partial-line/read boundaries and cursor commitment. Pure goal parsing and session scheduling do not establish these storage facts.
Validation: focused Node/tsx command above with `src/agent-host/adapters/claude/goal-transcript.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| finds a transcript under the exact dir, and nothing that is not there | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual((await readAll(transcript, SESSION))?.map((row) => row.condition), ["ship it"])`. |
| finds a long project path's dir by its prefix (its hash is the CLI's own) | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( (await readAll(new ClaudeGoalTranscript({ configDir, cwd }), SESSION))?.map((row) => row.condition), ["long path"] )`. |
| falls back to the cwd's real path when the CLI resolved a symlink | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( (await readAll(new ClaudeGoalTranscript({ configDir, cwd: linkedProject }), SESSION))?.map((row) => row.condition), ["real path"] )`. |
| reads only rows it has not read before | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(first, [{ met: false, sentinel: true, failed: false, condition: "ship it" }])`. |
| leaves a line still being written for the next read | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal((await readAll(transcript, SESSION))?.length, 1)`. |
| walks the file in bounded reads, rows split across reads included | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( rows?.map((row) => row.reason), Array.from({ length: 9 }, (_, index) => \`check ${index}\`) )`. |
| skips a line longer than one whole read — a goal row never is | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( (await readAll(transcript, SESSION))?.map((row) => row.met), [true, false] )`. |
| ignores rows that only mention goal_status | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(await readAll(transcript, SESSION), [])`. |
| starts a goal set in this session at its set point, never at an older row | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(await transcript.markSetPoint(SESSION), true)`. |
| finds the LAST goal_status row and leaves the position at the end | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(last, { row: { met: false, sentinel: true, failed: false, condition: "second" } })`. |
| anchors an unplaced position at the tail, never before an older run's rows | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(await transcript.anchorAtTail(SESSION), true)`. |
| keeps a position the resume scan placed: rows written after the scan are read | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(await transcript.anchorAtTail(SESSION), true)`. |
| reports a transcript with no goal rows as such | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(await transcript.readLast(SESSION), { row: undefined })`. |
| answers undefined, never throws, for a transcript that does not exist | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(await readAll(transcript, SESSION), undefined)`. |
| follows a new session id to its own file, from its start | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( (await readAll(transcript, "forked-session"))?.map((row) => row.met), [true] )`. |
| starts over when the file shrank under it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( (await readAll(transcript, SESSION))?.map((row) => row.met), [true] )`. |
| a chunk that is abandoned loses nothing an earlier chunk committed | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( [...first.rows, ...(again ?? [])].map((row) => row.reason), Array.from({ length: 14 }, (_, index) => \`check ${index}\`), "the abandoned chunk is read again without losing or duplicating rows" )`. |

### `apps/daemon/src/agent-host/adapters/claude/goal.test.ts`

Independent source (1): Goals design§§3.1,6.1 and Claude fixture observation23.
Stable seam (4) and refactor resistance (5): Goal text/row decoders and ClaudeGoalTracker; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Owns ambiguous/malformed provider grammar and distinct progress-throttle transitions; runtime framing tests cover emitted events, not every grammar alternative.
Validation: focused Node/tsx command above with `src/agent-host/adapters/claude/goal.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| reads a set | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(parseGoalCommandOutput("Goal set: ship the release with green tests"), { kind: "set", objective: "ship the release with green tests" })`. |
| keeps a multi-line condition whole and ignores surrounding whitespace | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(parseGoalCommandOutput(" Goal set: line one\nline two \n"), { kind: "set", objective: "line one\nline two" })`. |
| reads a bare /goal that has not been evaluated yet | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(parseGoalCommandOutput("Goal active: ship it (not yet evaluated)"), { kind: "active", objective: "ship it", rounds: 0 })`. |
| reads a bare /goal with rounds, singular and plural, and its last check | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(parseGoalCommandOutput("Goal active: ship it (1 turn)"), { kind: "active", objective: "ship it", rounds: 1 })`. |
| finds the status suffix behind a condition that has parentheses of its own | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(parseGoalCommandOutput("Goal active: fix (all of) the bugs (2 turns)"), { kind: "active", objective: "fix (all of) the bugs", rounds: 2 })`. |
| reads a clear, and both spellings of 'no goal' | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(parseGoalCommandOutput("Goal cleared: ship it"), { kind: "cleared", objective: "ship it" })`. |
| reads both refusals, and any other text, as no goal change | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( parseGoalCommandOutput("Goal condition is limited to 4000 characters (got 4012)"), { kind: "other" } )`. |
| takes the text from the content, falling back to the tagged local_command_source | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal( localCommandOutputText([{ type: "text", text: "Goal set: x" }], undefined), "Goal set: x" )`. |
| matches the tracked goal's feedback and reads the evaluator's reason | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( matchGoalStopHookFeedback( "Stop hook feedback:\n[ship the release]: the changelog is still missing", "ship the release" ), { reason: "the changelog is still missing" } )`. |
| does not claim another prompt hook's feedback | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal( matchGoalStopHookFeedback("Stop hook feedback:\n[lint is clean]: 3 errors", "ship it"), undefined )`. |
| matches a condition the CLI cut to 500 characters, marker and all | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( matchGoalStopHookFeedback( \`Stop hook feedback:\n[${cut}… [+${hidden} chars]]: nothing is done yet\`, objective ), { reason: "nothing is done yet" } )`. |
| finds the condition's end even when the condition itself contains ']: ' | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( matchGoalStopHookFeedback("Stop hook feedback:\n[a]: b]: the reason", "a]: b"), { reason: "the reason" } )`. |
| ignores text that is not a Stop-hook feedback frame | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(matchGoalStopHookFeedback("[ship it]: no", "ship it"), undefined)`. |
| reads the turn-end check-in and the idle one | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( parseGoalCheckIn( "Goal check-in: «ship it» is still active, and evaluation has been deferred for 31 min because background work is still running:\n- b1 · shell · npm test\nCheck on their progress (e.g. read their output)." ), { background…`. |
| reads the re-prompt after a turn that ended early as NOT waiting on background work | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( parseGoalCheckIn( "Goal check-in: «ship it» is still active. The last turn ended before the goal could be evaluated: the API returned an unexpected response. Continue toward the goal." ), { backgroundRunning: false } )`. |
| reads a value field-wise | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( parseActiveGoalValue({ condition: "ship it", iterations: 2, set_at: Date.parse("2026-09-24T09:00:00.000Z"), tokens_at_start: 1200, last_reason: "tests fail" }), { condition: "ship it", iterations: 2, setAt: "2026-09-24T09:00:00.000Z", last…`. |
| drops a set_at outside the Date range instead of throwing | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( parseActiveGoalValue({ condition: "ship it", iterations: 1, set_at: setAt }), { condition: "ship it", iterations: 1 }, String(setAt) )`. |
| reads null (and a missing value) as 'no goal', and a malformed one as nothing | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(parseActiveGoalValue(null), null)`. |
| reads the set sentinel, a check, a met, an impossible and a clear | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( parseGoalStatusRow(goalStatusRow({ met: false, sentinel: true, condition: "ship it" })), { met: false, sentinel: true, failed: false, condition: "ship it" } )`. |
| ignores every other row and drops malformed numbers | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(parseGoalStatusRow({ type: "attachment", attachment: { type: "date" } }), undefined)`. |
| applies restoreGoalFromTranscript's rule: the LAST row decides | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(transcriptGoalFromLastRow(undefined), { kind: "none" })`. |
| drops a seeded goal's updatedAt: the fold's stamp is not provider state | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(tracker.apply("progress", active()), { kind: "unchanged" })`. |
| never throttles anything but progress, and a real change supersedes a deferred one | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(tracker.apply("progress", active({ phase: "waiting-background" })).kind, "emit")`. |
| a progress back to the emitted state cancels the deferred one | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(tracker.apply("progress", active({ rounds: 1 })).kind, "emit")`. |

### `apps/daemon/src/agent-host/adapters/claude/history.test.ts`

Independent source (1): GUI design§4.5 rollback/history and managed-account identity; shipped worker output must survive an OS pipe.
Stable seam (4) and refactor resistance (5): createClaudeHistoryReader with actual worker/process pipes; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): The fake SDK lifecycle cannot catch truncated real stdout or ensure worker errors identify the failed history/fork operation.
Validation: focused Node/tsx command above with `src/agent-host/adapters/claude/history.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| reads a transcript far larger than the pipe buffer | OPTIMIZE | 512 independent native JSONL messages replace4000; retained returned count, final UUID and >64KiB serialized output still detect premature worker exit/truncated pipe output. No mock replaces the shipped worker. |
| a truncated payload is a named refusal, not a bare SyntaxError | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects( () => reader().readMessages({ sessionId: SESSION_ID }), operationFailure(/read.*history/i) )`. |
| names an empty payload rather than throwing 'Unexpected end of JSON input' | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects( () => reader().readMessages({ sessionId: SESSION_ID }), operationFailure(/read.*history/i) )`. |
| names unparsable output on the fork path too | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects( () => reader().fork({ sessionId: SESSION_ID, upToMessageId: "uuid-1" }), operationFailure(/fork.*conversation/i) )`. |

### `apps/daemon/src/agent-host/adapters/claude/launch.test.ts`

Independent source (1): GUI design§§3.2,4.3–4.5; SDK options contract; Agent Profiles design§6.1; fallback effort regression.
Stable seam (4) and refactor resistance (5): buildClaudeQueryOptions, decision/model resolution at the SDK boundary; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Owns the permission/model/launch table without spawning Claude. Lifecycle tests exercise execution; they do not enumerate unsupported capabilities, permission suggestions, or all malformed selections.
Validation: focused Node/tsx command above with `src/agent-host/adapters/claude/launch.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| the default row is named after the model it resolves to | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(named[0]?.slug, "default", "the launch still sends the CLI's own choice")`. |
| approval-required leaves permissionMode undefined so canUseTool is the gate | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(options.permissionMode, undefined)`. |
| auto-accept-edits maps to acceptEdits | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(options.permissionMode, "acceptEdits")`. |
| auto maps to auto | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(options.permissionMode, "auto")`. |
| full access maps to bypassPermissions plus the dangerous flag | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(options.permissionMode, "bypassPermissions")`. |
| sets exactly what §4.5 prescribes | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(options.cwd, "/work/project")`. |
| sends resume OR sessionId, never both | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(both.options.resume, "b46b654b-57bb-40e4-8c82-d3536bd06a28")`. |
| ultracode is xhigh effort PLUS the setting | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(options.effort, "xhigh")`. |
| gates a boolean option on the selected model's own capability | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(options.effort, undefined)`. |
| carries fastMode and thinking into settings where the model supports them | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(settings.fastMode, true)`. |
| the probe's options never run a hook and never open an MCP server | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(options.persistSession, false)`. |
| accept allows with the original input | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(result, { behavior: "allow", updatedInput: toolInput })`. |
| acceptForSession allows and rescopes every suggestion to the session | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(result.behavior, "allow")`. |
| acceptForSession falls back to a whole-tool session rule | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(permissionResultForDecision({ decision: "acceptForSession", toolName: "Bash", toolInput }), { behavior: "allow", updatedInput: toolInput, updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination…`. |
| acceptAlways denies — Claude has no permanent grant through canUseTool | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(result.behavior, "deny")`. |
| a decline with the user's words denies with them, trimmed and capped | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(feedback, { behavior: "deny", message: "do it in a branch" })`. |
| decline and cancel are two answers, not two labels | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(decline.behavior, "deny")`. |
| reads the CLI version out of its banner | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(parseClaudeVersion("2.1.210 (Claude Code)"), "2.1.210")`. |
| refuses an unreadable version rather than passing it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(meetsMinimumClaudeVersion(null), false)`. |
| builds effort descriptors from the CLI's own per-model levels | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( effort.options.map((option) => option.id), ["low", "medium", "high", "xhigh", "max"] )`. |
| only offers boolean descriptors the model advertises | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(haiku.capabilities, null)`. |
| passes the effort level through for a fallback alias with unknown capabilities | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(resolveEffortLevel({ model: "opus", options: [{ id: "effort", value: "high" }] }, opus), "high")`. |
| drops an effort level the selected model does not support | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(resolveEffortLevel({ model: "haiku", options: [{ id: "effort", value: "max" }] }, haiku), undefined)`. |
| keeps the CLI's resolved id beside the launch alias | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(model.subProvider, "claude-opus-4-8[1m]")`. |
| rides the flag-tier env, which the SDK passes on (it deletes NODE_OPTIONS from options.env) | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual((options.settings as Record<string, unknown>).env, { NODE_OPTIONS: PRELOAD })`. |
| keeps the settings files' value in front, since the flag tier replaces it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual((options.settings as Record<string, unknown>).env, { NODE_OPTIONS: \`--max-old-space-size=4096 ${PRELOAD}\` })`. |
| is absent without a NODE_OPTIONS in the env | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(settings !== undefined && "env" in settings, false)`. |
| a profile chat merges it into the carried env instead of replacing that | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(built.profileFiles?.settings.env, { TOKEN: "carried-secret", NODE_OPTIONS: \`--from-user ${PRELOAD}\` })`. |
| auto tool-search modes reach the flag tier alongside NODE_OPTIONS; explicit choices stay untouched | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(settings.env, { NODE_OPTIONS: "--preload", ...(expected !== undefined ? { ENABLE_TOOL_SEARCH: expected } : {}) }, \`ENABLE_TOOL_SEARCH=${String(value)}\`)`. |
| a profile chat overrides the carried user value in its settings file | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(built.profileFiles?.settings.env, { TOKEN: "carried-secret", ENABLE_TOOL_SEARCH: "true" })`. |
| a Global chat is untouched: user source, no strict MCP, no plugins, no skills, no launch files | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(options.settingSources, ["user", "project", "local"])`. |
| a profile chat gets the §6.1 recipe | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(options.settingSources, ["project", "local"])`. |
| no secret reaches the options themselves (argv) | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(serialized.includes("mcp-secret"), false)`. |
| merges the settings: carried < chat keys < recipe; denials concatenated; plugins switched off | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(built.profileFiles?.settings, { model: "opus", permissions: { allow: ["Bash(ls:*)"] }, env: { TOKEN: "carried-secret" }, // The chat's chip beats the carried user setting. alwaysThinkingEnabled: true, showThinkingSummaries: true, deniedMcpS…`. |
| a profile without built-in tools passes tools: [] and loads MCP tools up front | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(off.options.tools, [])`. |
| a profile without built-in tools loads no filesystem settings (no CLAUDE.md walked up from its cwd) | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(buildWith(profileLaunch({ disableBuiltinTools: true })).options.settingSources, [])`. |
| the Workflow tool off adds disableWorkflows; no MCP server means no --mcp-config | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(built.profileFiles?.settings.disableWorkflows, true)`. |
| built-in skills shown: no `skills` option; no instructions: the append is unchanged | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal("skills" in options, false)`. |

### `apps/daemon/src/agent-host/adapters/claude/lifecycle.test.ts`

Independent source (1): GUI design§§3.1–3.4,4.1–4.6,5.5; Claude fixture observations; profiles/goals contracts.
Stable seam (4) and refactor resistance (5): AgentAdapter operations/events against a scripted SDK Query; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Owns stateful SDK/session supervision and operation ordering. Pure normalizer, launch and planner tests cannot catch missing orchestration, timeout cleanup or concurrent operation races.
Validation: focused Node/tsx command above with `src/agent-host/adapters/claude/lifecycle.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| refuses when the binary cannot be resolved | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects(() => harness.adapter.startSession(START), /not installed/)`. |
| refuses a CLI below the minimum version, naming the version needed | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects(() => harness.adapter.startSession(START), /2\.1\.121 or newer/)`. |
| a spawn failure settles as an errored exit, not a hang | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects(() => harness.adapter.startSession(START), /EACCES/)`. |
| an expired handshake deadline kills the child instead of staying 'starting' | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects(starting, /timed out/)`. |
| a profile whose prepared dir cannot be read fails the start: no CLI, no session, never Global | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects( () => harness.adapter.startSession({ ...START, profile: { profileId: "p1", revision: "3", preparedDir: "/nonexistent/prepared/v-1" } }), /Agent Profile could not be loaded.*manifest is missing/ )`. |
| launches from the prepared dir with its 0600 launch files, removed when the session ends | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(options.settingSources, ["project", "local"])`. |
| never dispatches one of the user's skills, which a profile chat does not load | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(content.at(-1)?.text, "please $review")`. |
| lists and dispatches its own plugins' skills as plugin:skill, never the account's installed plugins | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( catalog?.skills.map((skill) => [skill.name, skill.scope]), [ ["dev-kit:review", "plugin"], ["toolbox:lint", "plugin"] ] )`. |
| starts, runs a turn and settles it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(record.status, "ready")`. |
| the host's NODE_OPTIONS reaches the CLI through the flag-tier env, after the settings files' own | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual((options.settings as Record<string, unknown>).env, { NODE_OPTIONS: '--max-old-space-size=4096 --require "/appdir/preload.cjs"' })`. |
| a system-home thread finds its user-scope skills under the host user's ~/.claude | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(content.at(-1)?.text, "/review", "the user-scope skill was found and dispatched")`. |
| under a skill dispatch, a path typed after the `$skill` mention is not repeated (§4.6.8) | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(content.at(-1)?.text, "/review /attachments/att-2")`. |
| under a skill dispatch, the block rides the LEADING text and the command block stays last and untouched (§4.5) | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(peer.received[0]?.message.content, [ { type: "text", text: "please\n\nAttached files:\n- q3.xlsx: /attachments/att-2" }, { type: "text", text: "/review" } ])`. |
| steering reuses the active turn rather than opening a second one | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(second.turnId, first.turnId, "a steer is not a second turn")`. |
| plan mode is per turn and restores the session's base mode | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(modes, ["plan", "default"])`. |
| refuses a promptless continuation — Claude does not declare the capability | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects( () => harness.adapter.sendTurn({ threadId: START.threadId, input: " ", attachments: [], interactionMode: "default", continuation: true }), /without a prompt/ )`. |
| compaction is the /compact turn and resolves when it settles | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(content.at(-1)?.text, "/compact")`. |
| puts the image blocks first and the path block inside the LAST text block | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( content.map((block) => block.type), ["image", "text"], "the text block stays LAST, so the typed /command still expands" )`. |
| 09: ExitPlanMode preserves the captured plan and denies the SDK gate, even in full access | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(decision.behavior, "deny")`. |
| full access allows a tool callback without opening an approval card | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(decision, { behavior: "allow", updatedInput: toolInput })`. |
| keys the card on the SDK's own request id and uses its description | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(requestId, "req-abc")`. |
| says why Claude asked, and offers no standing grant where the CLI forbids one | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(opened.payload.reason, "Permission rule Bash(rm:*) requires approval")`. |
| omits a reason Claude did not give, or one that only repeats the detail | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal("reason" in opened.payload, false, \`reason ${JSON.stringify(decisionReason)}\`)`. |
| a subagent's request says whose it is, and its decline carries the user's own words | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(opened.payload.requestingAgentId, "agent-explore-1")`. |
| a redirecting decline denies with the redirect message, a plain one with the decline | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(await redirected.decision, { behavior: "deny", message: APPROVAL_REDIRECT_MESSAGE })`. |
| a redelivered request does not open a second card | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(harness.events.filter((event) => event.type === "request.opened").length, 1)`. |
| a stop settles the open request as cancel BEFORE it closes the query | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(resolved?.payload, { requestType: "command_execution_approval", decision: "cancel", withdrawn: true })`. |
| an interrupt settles the pending request before the interrupt RPC | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(harness.adapter.hasSession(START.threadId), true)`. |
| a non-empty interrupt receipt escalates to closing the query | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(peer.closed, true, "Stop means stop: queued work escalates to a process kill")`. |
| an interrupt for a turn that is no longer active is a no-op | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(peer.calls.slice(callsBefore).some((call) => call.op === "interrupt"), false)`. |
| sends the stop_task control for that task alone, and the session lives on | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( peer.calls.slice(callsBefore).map((call) => [call.op, call.arg]), [["stopTask", "wvg2ao9ra"]], "no interrupt, no close: the turn and the other tasks keep running" )`. |
| rejects stopping a task without a live session | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects(harness.adapter.stopTask!(START.threadId, "wvg2ao9ra"), /No live Claude session/)`. |
| answers the commands the session's handshake reported, not the probe's; null without a live session | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(await harness.adapter.sessionCatalog!(START.threadId), null, "no session yet")`. |
| an option's preview reaches the card, and the chosen one rides back as an annotation | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(requested.payload.questions[0]!.id, "Which style?")`. |
| a stop settles an open question once, withdrawn | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(rows.length, 1)`. |
| the CLI aborting a pending request withdraws it once | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(rows.length, 1)`. |
| the user's own decision is never withdrawn | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(rows.length, 1)`. |
| a stream that ends mid-turn settles the turn and closes live tasks first | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(stopped?.payload.status, "stopped")`. |
| lazy recovery restarts from the persisted cursor | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(harness.adapter.hasSession(START.threadId), false)`. |
| the §6.1 create-time cursor resumes, and its first turn refreshes it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(options.resume, conversationId)`. |
| a cursor that fails its shape check means no resume, never an error | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(options.resume, undefined)`. |
| the liveness watchdog cancels a silent turn and pauses on a pending request | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(harness.adapter.hasSession(START.threadId), true, "paused, not cancelled")`. |
| forks the native session and restarts on the fork's id | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(snapshot.threadId, START.threadId)`. |
| rolling back every turn starts a fresh session rather than forking | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(snapshot.turns, [])`. |
| refuses a misaligned fork rather than guessing | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects( () => harness.adapter.rollbackThread(START.threadId, 1), /did not preserve the retained turn boundaries/ )`. |
| rejects a non-integer rewind | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects(() => harness.adapter.rollbackThread(START.threadId, 0), /integer >= 1/)`. |
| by id: keeps the turns before the target, resumes on the fork and closes the old peer | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( snapshot.turns.map((turn) => turn.id), [first], "one turn is kept, under its own id" )`. |
| by id: a count that disagrees with the ids is logged, and the id decides | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(snapshot.turns.map((turn) => turn.id), [first])`. |
| by id: a HISTORY turn of a resumed thread is rewindable, cut at its own anchor | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(forks, [{ sessionId: conversationId, cut: "hist-a1" }])`. |
| by id: a turn one rewind kept is still rewindable by its own id after the fork | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(liveCursor(harness).turnBoundaries, [ { turnId: a, uuid: "f1-a" }, { turnId: b, uuid: "f1-b" } ])`. |
| by id: a misaligned fork still refuses, and the live session is untouched | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects( () => harness.adapter.rollbackThread(START.threadId, 1, { firstRemovedTurnId: second!, droppedTurnIds: [second!], retainedTurnIds: [first!] }), /did not preserve the retained turn boundaries/ )`. |
| by id: an id the transcript cannot place refuses before any fork | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects( () => harness.adapter.rollbackThread(START.threadId, 1, { firstRemovedTurnId: "turn-nobody-started", droppedTurnIds: ["turn-nobody-started"], retainedTurnIds: [first!, second!] }), /turn boundary is unavailable/ )`. |
| probes without authenticating and publishes the §4.1 shape | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(snapshot.id, "claude")`. |
| degrades rather than throwing when the CLI is missing | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(snapshot.installed, false)`. |
| marks a below-minimum CLI degraded and does not probe it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(snapshot.status, "degraded")`. |
| R6 #1: a session-scoped Stop with no running turn stops the background work | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(harness.adapter.hasSession(START.threadId), true)`. |
| R6 #1: naming a turn that is not running is still a no-op | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(peer.closed, false)`. |
| Q1 #12: an already-aborted host signal still stops everything | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(closed, true, "the event stream must end when the host is already stopping")`. |
| Q1 #13: a compaction that never settles is bounded, not a permanent wedge | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects(compaction, /timed out/)`. |
| Q1 #14: a rewind during a live turn keeps the right number of turns | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(boundaries.length, 3)`. |
| Q1 #15 / R3 #5: a rewind across a compaction refuses BEFORE forking | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects( () => harness.adapter.rollbackThread(START.threadId, 1), /compacted after that turn/ )`. |
| Q1 #37: a redelivered question does not open a second card | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(harness.events.filter((e) => e.type === "user-input.requested").length, 1)`. |
| R3 #8: an undeclared dialog kind is not answered at all | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(answer, null)`. |
| idle compaction set to Never keeps the full history without asking; other modes ask | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(answer, { behavior: "completed", result: "continue" })`. |
| R3 #13: the probe runs under the account home when one is named | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(probeOptions.env?.CLAUDE_CONFIG_DIR, "/homes/acc-1/home")`. |
| Q1 #35: two probes with different keys do not share one in-flight result | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(wide.workspaceSnapshots?.some((e) => e.cwd === "/work/project") ?? false, false)`. |
| Q1 #38: a cursor naming another thread is rejected | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(options.resume, undefined, "a cursor copied onto the wrong thread must not resume")`. |
| a supervised start launches supervised — no permission mode, no skip flag | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(START.runtimeMode, "approval-required")`. |
| reads the native transcript and projects it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal( harness.events.some((event) => event.type === "turn.started"), false )`. |
| reads the transcript alongside the CLI's start-up when the host asks for it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(reads, 1, "read during the start, not after it")`. |
| an unreadable transcript degrades to an empty timeline, never an error | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(snapshot.turns, [])`. |
| tails the CLI's output file and drains it BEFORE the completion bookend | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(started.payload.isBackgrounded, true)`. |
| a poll whose read is in flight when the shell completes lands its bytes before the completion, once | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( deltas.map((event) => event.payload.delta), ["# pass 2\n"], "once — never read twice from one offset" )`. |
| an unreadable output file says so once and stops, rather than polling forever | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(harness.events.slice(after), [], "one notice, never a stream of them")`. |
| reads the window once the session is ready, before any turn has run | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(harness.peers[0]?.contextUsageCalls, 1)`. |
| refreshes after a result, attributing the row to the turn it was asked for | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(peer.contextUsageCalls, 2, "ready, then once per settled turn")`. |
| a CLI that rejects the control request never fails the turn and never warns | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(completed.payload.state, "completed")`. |
| an unanswered request expires on its own deadline rather than hanging the thread | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(completed.payload.state, "completed")`. |
| an SDK with no getContextUsage at all degrades silently | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(completed.payload.state, "completed")`. |
| declares the provider-command goal surface (goals §4.5) | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(harness.adapter.capabilities.goals, { command: "provider", actions: ["continue", "clear"], continuesAcrossTurns: false })`. |
| reads the transcript after a result: a met goal is `achieved`, after the turn's own events | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(achieved.payload.change, "achieved")`. |
| a row of the goal's previous run, behind the set point, never ends the new run | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(goalRows(harness, before), [], "the old met row is behind the set point")`. |
| still unmet with background work live at turn end is `waiting-background`; a throttled change is flushed by its timer | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(waiting.payload.change, "progress")`. |
| a session dying with a goal read parked finishes its teardown before its recovery starts | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(findEvent(harness.events, "session.exited", before), undefined, "still tearing down")`. |
| a stop on a session already closing waits for all of its teardown | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(stopped, false, "not while the first teardown is still running")`. |
| a met verdict the CLI writes ~100 ms AFTER its result is found by the re-read, stamped with the turn that ended | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(goalRows(harness, before), [], "the walk at the result finds no verdict yet")`. |
| an impossible verdict landing only by the second re-read is `failed` | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(goalRows(harness, before), [], "not there at the first re-read either")`. |
| a new turn supersedes a pending re-read | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(goalRows(harness, before), [], "the old retry cannot complete the new turn's goal")`. |
| a walk whose epoch moved before it started ends WITHOUT reading: its rows stay for the next walk | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(goalRows(harness, before).some((row) => row.payload.change === "achieved"), false)`. |
| a read that fails ends its walk and hands off to the next waiting walk | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(achieved.payload.change, "achieved")`. |
| a stop mid-way through a multi-chunk walk still lands the verdict before session.exited | KEEP | Named contract/unique failure at this boundary; oracle: `assert.ok( verdictAt >= 0 && verdictAt < exitAt, \`the verdict lands before the exit: ${tail.map((event) => event.type).join(", ")}\` )`. |
| two turn-end walks never interleave: a verdict keeps the turn that wrote it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(achieved.payload.change, "achieved")`. |
| a session that ends drops the waiting phase — unthrottled, before session.exited | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(waiting.payload.goal?.phase, "waiting-background")`. |
| a slow scan never resurrects a goal the user cleared meanwhile | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(cleared.payload.change, "cleared")`. |
| a goal the CLI re-arms but the thread lacks is `restored` | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(restored.payload.change, "restored")`. |
| a missing transcript leaves the thread's goal alone, with a debug line | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(goalRows(harness), [])`. |
| a fresh session holds no goal: the thread's is `cleared` | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(cleared.payload.change, "cleared")`. |
| a lazy recovery compares with the goal the dead session last reported, not the one it started with | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(replaced.payload.change, "replaced")`. |
| tails an agent's transcript into its member's drill-in, drained before the row that ends it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(coordinator.payload.taskId, WF_TASK)`. |
| never tails a path outside the account's projects directory | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(member.payload.taskId, MEMBER)`. |
| a session tool is pre-approved in Supervised mode: no card, no event | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(decision, { behavior: "allow", updatedInput: toolInput })`. |
| a same-named server's OTHER tool is still asked about | KEEP | Named contract/unique failure at this boundary; oracle: `assert.ok(await harness.waitFor("request.opened"))`. |
| without a registered toolkit, an `orquester` tool is no session tool and is asked about | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(options.mcpServers, {})`. |
| a fork's child runs its own in-process server, bound to the child — never the parent's (spec §6) | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(forked.resumeCursor, { threadId: "child", resume: FORKED })`. |
| the instruction block rides the system prompt, never the user's turn | KEEP | Named contract/unique failure at this boundary; oracle: `assert.ok((options.systemPrompt as { append: string }).append.includes(tools.instructions))`. |

### `apps/daemon/src/agent-host/adapters/claude/local-process.test.ts`

Independent source (1): Claude SDK custom-spawner exit/error contract; host-death lifeline guarantee.
Stable seam (4) and refactor resistance (5): claudeLifelineSpawner with real shell processes; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Owns exit-versus-stderr and spawn-error delivery at the real OS boundary, which scripted Query/ProviderChild mocks cannot establish.
Validation: focused Node/tsx command above with `src/agent-host/adapters/claude/local-process.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| reports the exit only after stderr written past it has reached the capture | OPTIMIZE | Replace the arbitrary 100ms shell sleep with a named FIFO. The SDK public exitCode condition is observed with event-loop yields before the writer is released; the real stderr capture must contain the fatal line when the public wrapper reports exit. Native setTimeout mocks hold the cap during this drain test; the separate real cap test remains. Cleanup kills any remaining process group and removes the FIFO. |
| does not wait past the cap for a stderr something else keeps open | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(code, 0)`. |
| a spawn error reaches the SDK's error listener and no exit is invented | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(error.code, "ENOENT")`. |

### `apps/daemon/src/agent-host/adapters/claude/normalize.goal.test.ts`

Independent source (1): Goals design§6.1 and Claude protocol observation23.
Stable seam (4) and refactor resistance (5): ClaudeNormalizer provider frames → RuntimeEvent; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Owns goal-event attribution, suppression, transcript reconciliation and lifecycle framing; pure parser tests cannot prove the normalized event stream.
Validation: focused Node/tsx command above with `src/agent-host/adapters/claude/normalize.goal.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| completes a <synthetic> frame's text at the frame, not at the result | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(types(atFrame), [ "item.started:assistant_message", "content.delta:assistant_text", "item.completed:assistant_message" ])`. |
| opens a turn for a <synthetic> frame that arrives between turns, and still completes it at once | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(types(events).slice(0, 5), [ "turn.started", "session.state.changed", "item.started:assistant_message", "content.delta:assistant_text", "item.completed:assistant_message" ])`. |
| leaves an ordinary snapshot-only frame as it was: its text still waits for the result | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(types(feed(frame)), ["item.started:assistant_message"])`. |
| a set emits `set` after the text, with the whole goal and the set time | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(types(events), [ "item.started:assistant_message", "content.delta:assistant_text", "item.completed:assistant_message", "thread.goal.updated" ])`. |
| a set over a different running goal is `replaced`; the same goal again is no change | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(goalEvents(feed(goalOutput("Goal set: ship the release"))), [])`. |
| a bare /goal reports rounds and the last check as progress on the tracked goal | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( goalEvents(feed(goalOutput("Goal active: ship the release (not yet evaluated)"))), [], "nothing moved" )`. |
| a bare /goal naming a goal nobody tracked is `restored` | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(restored?.payload, { goal: { ...SHIP, rounds: 1 }, change: "restored" })`. |
| a clear is `cleared` with the goal that ended; 'No goal set' clears only a tracked goal | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(cleared?.payload, { goal: null, change: "cleared", previous: { ...SHIP, rounds: 3 } })`. |
| the refusals change nothing, and their text still renders | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(goalEvents(events), [])`. |
| another local command's output is never read as a goal | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(goalEvents(events), [])`. |
| falls back to local_command_source when the content carries no text | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(set?.payload.goal?.objective, "ship the release")`. |
| the tracked goal's feedback is `checked`, one round more, and never a user message | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(types(events), ["thread.goal.updated"], "nothing else: no row for the frame")`. |
| another hook's feedback keeps today's behaviour: no goal change, no row | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(events, [])`. |
| feedback with no tracked goal changes nothing | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(feed(syntheticUser("Stop hook feedback:\n[ship the release]: no")), [])`. |
| a check-in is `progress` waiting on background work, and never a user message | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(types(events), ["thread.goal.updated"])`. |
| the re-prompt after a turn that ended early is progress WITHOUT the waiting phase | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(types(events), ["thread.goal.updated"], "consumed, never a user message")`. |
| is recognised before the exhaustiveness switch, never a warning | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(events.filter((event) => event.type === "runtime.warning").length, 0)`. |
| a value that moves nothing but the counters is progress, or nothing at all | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( goalEvents(feed(activeGoal({ condition: "ship the release", iterations: 2, last_reason: "x" }))), [] )`. |
| a value naming an untracked goal is `restored` | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(restored?.payload.change, "restored")`. |
| null asks the session for the transcript check, and emits nothing itself | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(feed(activeGoal(null)), [])`. |
| a malformed value is ignored, not warned about | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(feed(activeGoal({ condition: 42 })), [])`. |
| a met row is `achieved`, with the CLI's own totals on the goal that ended | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(types(events), ["thread.goal.updated"])`. |
| a failed row is `failed`, with the evaluator's reason | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(failed?.payload, { goal: null, change: "failed", previous: { objective: "ship the release", status: "failed", rounds: 1, lastCheck: "there is no repo" } })`. |
| a clear by an unrecoverable error — a met sentinel — is `cleared` | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(cleared?.payload, { goal: null, change: "cleared", previous: SHIP })`. |
| rows about another condition, and checks already seen on stdout, change nothing | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( normalizer.applyGoalTranscriptRows( [ row({ met: true, condition: "an older goal", iterations: 4 }), row({ met: false, condition: "ship the release", reason: "not yet" }), row({ met: false, sentinel: true, condition: "ship the release" }) …`. |
| still unmet with background work live at turn end is `waiting-background`, and back when it is not | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(waiting?.payload, { goal: { ...SHIP, phase: "waiting-background" }, change: "progress" })`. |
| an `active_goal: null` re-read applies ended rows but never touches the phase | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( normalizer.applyGoalTranscriptRows([], { backgroundLive: true, atTurnEnd: false }), [] )`. |
| a read asked for before the same goal was set again is moot | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( normalizer.applyGoalTranscriptRows([row({ met: true, condition: "ship the release", iterations: 9 })], { atTurnEnd: true, backgroundLive: false, epoch: askedAt }), [], "the previous run's verdict never ends the new run" )`. |
| with no goal tracked, nothing is read into it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( normalizer.applyGoalTranscriptRows([row({ met: true, condition: "ship the release" })], { atTurnEnd: true, backgroundLive: true }), [] )`. |
| the same goal on both sides is no news | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( normalizer.reconcileTranscriptGoal(last({ met: false, condition: "ship the release", reason: "x" })), [] )`. |
| a different goal in the transcript replaces the fold's | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(restored?.payload.change, "restored")`. |
| the fold's goal that the transcript ended is `achieved`, `failed` or `cleared` | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal( goalEvents(met.normalizer.reconcileTranscriptGoal(last({ met: true, condition: "ship the release", iterations: 2 })))[0] ?.payload.change, "achieved" )`. |
| the fold's goal with no goal_status at all is `cleared`; no goal on either side is nothing | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(goalEvents(tracked.normalizer.reconcileTranscriptGoal(last(undefined)))[0]?.payload, { goal: null, change: "cleared", previous: SHIP })`. |
| a session that ends flushes a throttled progress rather than dropping it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(goalEvents(feed(goalOutput("Goal active: ship the release (1 turn)"))).length, 1)`. |
| a new process has nothing in the background: a stale waiting phase is dropped | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(progress?.payload, { goal: SHIP, change: "progress" })`. |

### `apps/daemon/src/agent-host/adapters/claude/normalize.test.ts`

Independent source (1): GUI design§§4.2,4.5,9; committed Claude protocol observations1–24.
Stable seam (4) and refactor resistance (5): ClaudeNormalizer provider frames → RuntimeEvent; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Owns the raw-provider decode and emitted identity/content/state; generic ingestion/fold tests have no knowledge of Claude-specific frame grammar.
Validation: focused Node/tsx command above with `src/agent-host/adapters/claude/normalize.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| 01: a plain text turn streams and settles | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(deltas, "OK")`. |
| 02: an auto-allowed tool produces item rows and no approval | KEEP | Named contract/unique failure at this boundary; oracle: `assert.ok(!types.includes("request.opened"))`. |
| 07: a subagent and a background shell carry full linkage on every row | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(agent.payload.role, "Explore")`. |
| 08: the step list is TaskCreate/TaskUpdate, not TodoWrite | KEEP | Named contract/unique failure at this boundary; oracle: `assert.ok(plans.length >= 3, \`expected plan updates, got ${plans.length}\`)`. |
| 10: an interrupt settles the turn as interrupted without a diagnostic banner | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(completed?.state, "interrupted")`. |
| 12: a compaction reports before/after and does not fail the turn | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(compacted.length, 1)`. |
| 15: a warning-level rate_limit_event carries a percentage; a plain one does not | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(updates.length, 1)`. |
| 16: an unknown model fails the turn with the CLI's own sentence | KEEP | Named contract/unique failure at this boundary; oracle: `assert.ok(completed.length >= 2)`. |
| surfaces an unknown top-level message as a warning, never silently | KEEP | Named contract/unique failure at this boundary; oracle: `assert.ok(warning)`. |
| surfaces an unknown system subtype as a warning | KEEP | Named contract/unique failure at this boundary; oracle: `assert.ok(warning)`. |
| consumes the undeclared wire-only frames without a warning | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal( events.filter((event) => event.type === "runtime.warning").length, 0, JSON.stringify(frame) )`. |
| a warning never ends an active turn | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(events.filter((event) => event.type === "turn.completed").length, 0)`. |
| system/init is idempotent state, not a per-turn event | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(eventTypes(first), ["thread.started"])`. |
| a model the adapter did not ask for is reported as a reroute | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(rerouted.payload.fromModel, "claude-opus-4-8")`. |
| system/status is deduped rather than emitted three times per turn | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(first.filter((event) => event.type === "session.state.changed").length, 1)`. |
| a user message whose content is a plain string does not throw | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(eventTypes(events), ["thread.started"])`. |
| records the uuids a compaction preserved | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(normalizer.preservedMessageUuids, undefined)`. |
| turns a subagent's tool_use/tool_result and text into items owned by its task | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(startedItem.itemId, "toolu_child")`. |
| holds its frames until a task carries the same description, then attributes them | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(early, [], "unattributable frames are held, never shown as the parent's work")`. |
| a resumed agent's start — same task, a new launching call — carries the resume's own prompt | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(first?.payload.prompt, "Audit the store.")`. |
| a start whose frame names no prompt takes the one its own launching Agent call carried | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(start?.payload.prompt, "From the call's input.")`. |
| a shell's start never carries a prompt, whatever its frame or its call named | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal("prompt" in shell.payload, false)`. |
| matches the CLI's per-block assistant frame to its streamed block by order, not array index | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(started.length, 1, "one assistant text item, not one per frame")`. |
| a second message whose text streams behind a thinking block again is a NEW item, not an append | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(items.started.length, 2, "one assistant item per API message")`. |
| holds without thinking too: two messages with text at index 0 are two items | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(items.started.length, 2)`. |
| an opening message that thinks first is ONE item, closed in place, and keeps its thinking | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(turnIds.length, 1, "one synthetic turn")`. |
| an opening message with no thinking is closed in place, not held back to `result` | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(started.length, 2)`. |
| a user turn that opens mid-message adopts the message streaming so far | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( assistantText(all).map(([, text]) => text), ["All checks are now clean."] )`. |
| a user turn that auto-closes a synthetic turn mid-message keeps that message's join | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( assistantText([...all, ...atResult]).map(([, text]) => text), ["Opening.", head, tail, "Final answer."], "the block splits at the turn boundary, and nothing is said twice" )`. |
| a turn that begins while a synthetic turn is open settles that turn first, never overwrites it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual([...completed].sort(), [...started].sort(), "no assistant item is left open")`. |
| a woken message says the session is working at its message_start, before its turn exists | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(states(first), [["running", "wake:streaming", undefined]], "at the held message_start, with no turn")`. |
| a woken message that stops with no turn opening puts the session back to ready | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( events.filter((event) => event.type === "session.state.changed").map((event) => (event.payload as { state: string }).state), ["running", "ready"] )`. |
| a held message keeps every delta, however long its first block streams | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal( thinking(all).map(([delta]) => delta).join(""), thinkingDeltas.join(""), "every thinking delta reaches the turn, in order" )`. |
| a message that ended before any turn opened is never replayed into a later turn | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( assistantText(all).map(([, text]) => text), ["Fresh."], \`a message closed by ${end} stays out of the next turn\` )`. |
| opens the phase on the FIRST compacting status and never re-opens it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(opened.length, 1, "the client learns the CLI is compacting, not merely running")`. |
| a failed compaction ends the phase with the provider's own reason and warns | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal( failed.type === "thread.state.changed" ? failed.payload.error : undefined, "Not enough context." )`. |
| a successful compaction adds nothing: the boundary already reports it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( settled.filter((event) => event.type === "thread.state.changed"), [] )`. |
| a SECOND compaction later in the same session opens the phase again | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal( again.filter( (event) => event.type === "thread.state.changed" && event.payload.state === "compacting" ).length, 1 )`. |
| is not surfaced at all: no task rows, no liveness, no shell item | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( started.filter((event) => event.type === "task.started"), [], "a blocking Bash call is already its own tool row" )`. |
| a later move to the background PROMOTES it: task.started, its shell item, then the update | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(types, ["task.started", "item.started", "task.updated"], JSON.stringify(types))`. |
| surfaces the task and opens a command_execution item attributed to it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(payloadOf(task).isBackgrounded, true)`. |
| parses the output file out of the launch tool_result and asks the session to tail it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(changes, [ { kind: "tail", taskId: SHELL_TASK_ID, outputFile: \`/var/lib/orquester/tmp/claude-999/-var-lib-orquester/1ea82399/tasks/${SHELL_TASK_ID}.output\` } ])`. |
| keeps a ~-abbreviated path verbatim — resolving it is the session's job | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(changes[0]?.kind, "tail")`. |
| closes the item BEFORE the task row and carries the exit code on both | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( order, ["item.completed", "task.completed"], "ingestion closes the output buffer on item.completed, so the item settles first" )`. |
| a non-zero exit fails the item even when the notification says completed | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(item.status, "failed")`. |
| an unknown exit code leaves the item's verdict to the notification | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(item.status, "failed")`. |
| an ambient or skip_transcript task is never surfaced | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( started.filter((event) => event.type === "task.started"), [], \`${flag} is housekeeping, not activity\` )`. |
| closeLiveTasks fails the open shell item and stops its tail | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(types, ["item.completed", "task.completed"], JSON.stringify(types))`. |
| never invents a terminal status for a task missing from the snapshot | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(live.at(-1), [SHELL_TASK_ID])`. |
| answers the host's liveness check by the CLI's own accounting, never by silence | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(normalizer.backgroundTaskLive(SHELL_TASK_ID), undefined, "a task it never named")`. |
| still registers a task it names first, and leaves orphan notifications alone | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(payloadOf(completed).status, "stopped")`. |
| does not retitle a task from its progress frames' live-activity description | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(payload.title, "Audit the workflows", "the linkage title is the task's own description")`. |
| a subagent's task_progress usage never moves the thread meter | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( allOf(progress, "thread.token-usage.updated"), [], "a subagent's cumulative total is roster data, not the thread's context size" )`. |
| a nested stream frame's message_delta usage never moves the thread meter | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(allOf(nested, "thread.token-usage.updated"), [])`. |
| a result with no assistant usage keeps the last known reading, never result.usage | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(allOf(opening, "thread.token-usage.updated")[0]?.payload.usage.usedTokens, 4_100)`. |
| totalProcessedTokens is the cumulative modelUsage sum, not result.usage | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(emitted.payload.usage.totalProcessedTokens, 393_100)`. |
| folds an authoritative getContextUsage response through the same dedupe | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(first.length, 1)`. |
| a result's nominal per-model window never overwrites the authoritative one | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(normalizer.lastKnownContextWindow, 200_000)`. |
| projects a nested thinking block as the agent's own reasoning row | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(started.length, 1, "one reasoning row per nested thinking block")`. |
| keeps the agent's text and its thinking on separate items | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(itemsByKind.get("reasoning")?.size, 1)`. |
| a nested stream_event never touches the parent's text block | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(nested, [], "a nested stream frame produces nothing at all")`. |
| holds the boundary until the synthetic summary that follows it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( atBoundary.filter((event) => event.type === "thread.state.changed"), [], "the marker waits one frame for the summary the CLI is about to send" )`. |
| flushes the marker unchanged when the next frame is something else | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(compacted?.state, "compacted")`. |
| a synthetic frame that is not this boundary's anchor stays a normal frame | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(compactionOf(other)?.summary, undefined, "the anchor is the join, not the shape")`. |
| leaves the `<local-command-stdout>` replay frame exactly as it was | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(replay, [], "it was never a row and still is not")`. |
| a nested Bash and a nested Write stamp their output with the owning task | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( bash.map((event) => [event.payload.streamKind, event.agentId, event.turnId]), [["command_output", AGENT_TASK_ID, "turn-1"]] )`. |
| a frame held for its owner and a resumed agent's later frames both carry the owner | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(held, [], "both frames wait for an owner")`. |
| a depth-2 agent's output carries the innermost agent, as the call's rows do | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(item?.agentId, "task-B")`. |
| a subagent's background launch: its placeholder carries the subagent, the shell's chunks the shell | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( outputDeltas(placeholder).map((event) => [event.itemId, event.agentId]), [["toolu_S", AGENT_TASK_ID]] )`. |
| a CLI-denied subagent Bash carries its owner on the output and on the denial | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( outputDeltas(denied).map((event) => event.agentId), [AGENT_TASK_ID] )`. |
| a denial for a call the adapter never saw still names the subagent that raised it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(denial.payload.toolName, "unknown")`. |
| the parent's own output carries no owner | KEEP | Named contract/unique failure at this boundary; oracle: `assert.ok(output.length > 0, \`${fixture} streams the parent's output\`)`. |
| a nested tool_result with no parent turn emits its output, stamped and turnless | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(rest, [])`. |
| the parent's result leaves the agent's call open; its own result lands whole, on the call's turn | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(allOf(ended, "turn.completed").length, 1, "the parent's turn ends")`. |
| neither does the auto-close of a stale synthetic turn | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(completionsOf(normalizer.completeTurn("completed"), "toolu_X"), [])`. |
| the owner's task_notification first closes its open calls, failed, each on its own turn | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( ended .filter((event) => event.type === "item.completed" \|\| event.type === "task.completed") .map((event) => [ event.type, event.itemId, event.turnId, event.agentId, (event.payload as { status?: string }).status ]), [ ["item.completed", "t…`. |
| a terminal task_updated closes them too, before its row | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( ended.map((event) => [event.type, event.itemId]), [ ["item.completed", "toolu_X"], ["task.updated", undefined] ] )`. |
| a running status patch closes nothing | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(completionsOf(updated, "toolu_X"), [])`. |
| closeLiveTasks closes every call a subagent still has open, before the task rows | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( closed.map((event) => [event.type, event.itemId, event.turnId, event.agentId]), [ ["item.completed", "toolu_X", "turn-1", AGENT_TASK_ID], ["item.completed", "toolu_Y", undefined, AGENT_TASK_ID], ["task.completed", undefined, undefined, und…`. |
| a foreground agent's calls are still settled at the parent's turn end | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(forced.length, 1, JSON.stringify(taskStarted))`. |
| a foreground agent running inside a background one works on with it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(completionsOf(ended, "toolu_C"), [], "B's call runs on inside A")`. |
| a parent call streamed before its synthetic turn opens is held with its message, and rides that turn from its start | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( early.filter((event) => event.itemId === "toolu_P"), [], "nothing of the call goes out before its turn opens" )`. |
| a parent call streamed before a USER turn opens in that window is held, and rides the user turn from its start | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(started.filter((event) => event.itemId === "toolu_P"), [])`. |
| a call streamed after its message's run ended rides that message's turn, closed at once — the next turn takes none of it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(allOf(ended, "turn.completed")[0]?.payload.state, "interrupted")`. |
| a call a held message streams after that message was dropped with its run goes nowhere | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(tail.filter((event) => event.itemId === "toolu_H"), [])`. |
| a call a message streams after the adapter itself settled its turn rides that turn and runs on there | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( started.filter((event) => event.itemId === "toolu_B").map((event) => [event.type, event.turnId]), [["item.started", "turn-syn"]] )`. |
| a subagent's tool_progress is its owner's heartbeat, on the call's own turn | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( [inTurn?.payload.taskId, inTurn?.agentId, inTurn?.turnId], [AGENT_TASK_ID, AGENT_TASK_ID, "turn-1"] )`. |
| a tool_progress task_id counts only when it names a surfaced local_agent task | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(parent.payload.taskId, undefined, "a parent tool's progress is never persisted")`. |
| a rejected window's parked-turn warning is a usage limit with its reset | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(failures(events), [["runtime.warning", "usage_limit", RESETS_ISO]])`. |
| a window with no reset time names none | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(failures(events), [["runtime.warning", "usage_limit", undefined]])`. |
| an allowed window says nothing | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(failures(make().handleMessage(rateLimit("allowed", RESETS_AT))), [])`. |
| a failed result after a rejected window is a usage limit, reset = the latest window | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(failures(events), [ ["runtime.error", "usage_limit", new Date((RESETS_AT + 3600) * 1000).toISOString()] ])`. |
| a window that cleared no longer names the failure | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(failures(events), [["runtime.error", undefined, undefined]])`. |
| an assistant frame flagged rate_limit makes the failed result a usage limit | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(failures(events), [["runtime.error", "usage_limit", undefined]])`. |
| authentication_failed, and a 401 or 403, are auth | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(failures(normalizer.handleMessage(failedResult(401))), [ ["runtime.error", "auth", undefined] ])`. |
| a rejected window BETWEEN parent turns (background agents working on) still raises the usage limit, with no turn | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(failures(events), [["runtime.warning", "usage_limit", RESETS_ISO]])`. |
| a window that cleared between turns is not handed to the next turn | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(failures(normalizer.handleMessage(failedResult(500))), [["runtime.error", undefined, undefined]])`. |
| the recorded unknown-model failure names no account failure | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( failures(events).filter(([, reason]) => reason !== undefined), [] )`. |
| is a to-do row, never a file change, and its todos become the turn's plan | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(plan, [ { step: "Read the code", status: "completed" }, { step: "Fix the bug", status: "inProgress" }, { step: "Run the tests", status: "pending" } ])`. |

### `apps/daemon/src/agent-host/adapters/claude/profile-isolation.live.test.ts`

Independent source (1): Agent Profiles design2026-10-18 §§6.1,8.
Stable seam (4) and refactor resistance (5): Real Claude CLI introspection, no model call; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Only the real CLI can prove native option/config precedence excludes global items. Global fixture presence is verified so negative isolation assertions are not vacuous. This existing opt-in suite was not newly skipped.
Validation: focused Node/tsx command above with `src/agent-host/adapters/claude/profile-isolation.live.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| a Global launch of the fixture sees the user's items (baseline) | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(seen.plugins, ["gplug2@fakemkt", "gplug@fakemkt"])`. |
| a profile launch sees only the profile's items, the project's own and Orquester's | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(existsSync(join(world.markers, "user-hook")), false, "the user's SessionStart hook stays out")`. |
| the Workflow tool off drops workflow-authoring; built-ins shown lifts the allow-list | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(off.skills.includes("workflow-authoring"), false, off.skills.join(", "))`. |

### `apps/daemon/src/agent-host/adapters/claude/profile-launch.test.ts`

Independent source (1): Agent Profiles design§6.1; 0600 secret-bearing launch-file and box-filesystem contracts.
Stable seam (4) and refactor resistance (5): loadClaudeProfileLaunch plus real prepared/user/project files; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Owns assembly and physical permissions/file cleanup; launcher field tests cannot prove disk parsing or box-versus-host file identity.
Validation: focused Node/tsx command above with `src/agent-host/adapters/claude/profile-launch.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| is null for a Global thread, without reading anything | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(await loadClaudeProfileLaunch({ cwd: "/nowhere" }, { configDir: "/x", claudeJson: "/x/.claude.json", home: "/x" }), null)`. |
| assembles the launch from the prepared dir, the account and the project | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(launch.plugins, [ { type: "local", path: join(preparedDir, "plugin") }, { type: "local", path: join(preparedDir, "plugins", "pl1"), skipMcpDiscovery: true } ])`. |
| boxes: reads a box project's files in its box — the host directory is an empty stub | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal("projmcp" in fromStub.mcpServers, false, "the stub has no .mcp.json")`. |
| tolerates a missing or invalid user settings.json | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual((await loadClaudeProfileLaunch({ profile, cwd }, where))?.carriedSettings, {})`. |
| fails the start for a missing manifest, another revision, or a missing prepared file | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects( loadClaudeProfileLaunch({ profile: { ...profile, revision: "4" }, cwd }, where), (error: unknown) => error instanceof ProfileLaunchError && /another version/.test(error.message) )`. |
| a profile without built-in tools lifts no project or ancestor .mcp.json server, only its own | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal("ancestor" in plain.mcpServers, true, "a user profile keeps the project walk")`. |
| refuses a section path that leaves the prepared dir | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects(loadClaudeProfileLaunch({ profile, cwd }, where), ProfileLaunchError)`. |
| are 0600 in a 0700 per-thread dir, replaced on rewrite and removed whole | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal((await stat(files.dir)).mode & 0o777, 0o700)`. |
| create their 0700 parent and refuse one that is not a private, real directory of this user | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal((await lstat(join(root, "claude-profile-launch"))).mode & 0o777, 0o700)`. |

### `apps/daemon/src/agent-host/adapters/claude/project-history.test.ts`

Independent source (1): GUI design§4.1 history projection; Claude observed resume does not replay history (observation8).
Stable seam (4) and refactor resistance (5): projectClaudeHistory native transcript → RuntimeEvent; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Resumed-history projection differs from live streaming. These cases own historical stamps, synthetic-message filtering, tool results and turn grouping absent from live-normalizer coverage.
Validation: focused Node/tsx command above with `src/agent-host/adapters/claude/project-history.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| projects one turn.started/turn.completed pair per turn | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(started.length, snapshot.turns.length)`. |
| stamps every event as historical, never as a live frame | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(event.raw?.source, HISTORICAL_RAW_SOURCE, event.type)`. |
| carries the messages' text on item.completed rows | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(event.payload.status, "completed")`. |
| pairs a tool_use with its tool_result on one item keyed by the tool-use id | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(tools.length, 1)`. |
| projects reasoning as a reasoning row plus a summary delta | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(reasoning.length, 1)`. |
| carries the turn's model onto turn.started | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(allOf(events, "turn.started")[0]!.payload.model, "claude-sonnet-5")`. |
| closes a tool call whose result never arrived rather than leaving it live | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(tool.payload.status, "failed")`. |
| renders a CLI denial as declined, not as a plain failure | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(tool?.payload.status, "declined")`. |
| survives a string `content`, which is what a compacted thread holds | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(item?.payload.itemType, "user_message")`. |
| replays a prompt without the `Attached files:` block the adapter appended to it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(user?.payload.detail, "hello")`. |
| keeps the block of an attachment-only prompt, the turn's only evidence in a replay | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(user?.payload.data, { text: block })`. |
| shows the command block, not the block-only leading text, of a dispatch with attachments and no prose | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(user.length, 1, "exactly one user row")`. |
| keeps a block-only text block that is the message's only text when an image block sits beside it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(user.length, 1)`. |
| projects nothing for a turn with nothing projectable | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( project({ threadId: "t", turns: [{ id: "turn-1", items: [{ type: "system" }] }] }), [] )`. |
| opens a turn at each human prompt and drops the preamble | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( turns.map((turn) => turn.id), ["turn-a", "turn-b"] )`. |
| replays it as the compaction marker, carrying the summary | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(markers.length, 1, "one marker for one compaction")`. |
| replays each notification as the task.completed row the live stream makes of it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(userTexts, ["run the tests"])`. |
| replays only what the user typed as user messages, a command as they typed it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(userTexts, ["fix the bug", "try again", "/compact", "/review the auth module"])`. |
| settles a turn the user interrupted as interrupted, as the live turn was | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(states, [ ["turn-a", "interrupted"], ["turn-b", "interrupted"], ["turn-c", "completed"], ["turn-d", "completed"] ])`. |
| replays the turn it opened without a user message, as live | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(items, [ ["turn-a", "user_message"], ["turn-b", "assistant_message"] ])`. |

### `apps/daemon/src/agent-host/adapters/claude/prompt-cache.test.ts`

Independent source (1): Idle-compaction prompt-cache-expiry contract; provider cache_creation1h/5m wire fields.
Stable seam (4) and refactor resistance (5): ClaudeNormalizer usage events / cache-TTL parser; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Owns request-time expiry, held-frame replay, cache refresh and subagent exclusion. Numeric usage tests do not establish temporal expiry or session-local cache state.
Validation: focused Node/tsx command above with `src/agent-host/adapters/claude/prompt-cache.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| reads 1h before 5m, from the top level or the last iteration, and unknown without a write | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(claudePromptCacheTtlMs({ cache_creation: { ephemeral_1h_input_tokens: 5, ephemeral_5m_input_tokens: 9 } }), HOUR)`. |
| fixture 15: the 1h write on message_start expires an hour after the request | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(stamped[0]?.promptCacheTtlMs, HOUR)`. |
| measures from the request's start, not from its response; a 5m write expires five minutes after it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(usage?.promptCacheTtlMs, 5 * MINUTE)`. |
| every later reading carries the latest request's expiry; a request that wrote nothing makes it unknown | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(context?.promptCacheExpiresAt, "2026-10-22T11:00:00.000Z")`. |
| a message held for its turn and replayed into it keeps its own request time | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(usage?.promptCacheExpiresAt, "2026-10-22T11:00:00.000Z")`. |
| only the expiry moving is still a new reading | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(readings(normalizer.handleMessage(messageDelta())).length, 1)`. |
| a subagent's request never moves the conversation's cache, and a compaction forgets it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(usage?.promptCacheTtlMs, HOUR)`. |

### `apps/daemon/src/agent-host/adapters/claude/rollback.test.ts`

Independent source (1): GUI design§§4.1,4.5,5.5; Claude observations8,20–21.
Stable seam (4) and refactor resistance (5): Rollback planners, resume cursor and fork boundary mapping; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Owns independently supplied transcript/cursor alignment and refuse-rather-than-guess rules. Lifecycle/fork happy paths cannot cover every ambiguous/reminted/compacted history boundary.
Validation: focused Node/tsx command above with `src/agent-host/adapters/claude/rollback.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| counts only human prompts, never tool results or meta notices | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(isClaudeHumanTurnStart(user("u1", "hello")), true)`. |
| keeps the turns before the removed one and anchors on the last kept entry | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(plan.retainedCount, 2)`. |
| infers boundaries from history only when the turn counts agree | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(plan.retainedBoundaries, ["t1", "t2"])`. |
| refuses when a boundary is missing from the history | KEEP | Named contract/unique failure at this boundary; oracle: `assert.throws( () => planClaudeRollback({ messages, boundaries: ["t1", "gone"], numTurns: 1 }), /turn boundary is unavailable/i )`. |
| refuses an empty history | KEEP | Named contract/unique failure at this boundary; oracle: `assert.throws( () => planClaudeRollback({ messages: [], boundaries: ["t1"], numTurns: 1 }), /history is unavailable/i )`. |
| returns no anchor when every turn is removed | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(plan.retainedCount, 0)`. |
| remaps onto the fork's rewritten uuids | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(remapped, ["f1"])`. |
| refuses when a retained body differs — role matching alone is not enough | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(remapClaudeForkTurnBoundaries(messages, fork, 2, ["t1"]), undefined)`. |
| refuses when the fork dropped a retained message | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(remapClaudeForkTurnBoundaries(messages, fork, 2, ["t1"]), undefined)`. |
| a compaction makes an anchor outside the preserved set unreachable | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal( isAnchorReachableAfterCompaction({ anchorUuid: "a1", preservedUuids: ["a1", "a2"] }), true )`. |
| with the transcript at hand, the last compaction summary's position decides | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal( isAnchorReachableAfterCompaction({ anchorUuid: "a2", preservedUuids, messages: transcript }), true )`. |
| resolves a history turn no cursor recorded by identity — its id IS its uuid | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(plan.firstRemoved, 2)`. |
| resolves a turn whose uuid a fork rewrote through its recorded pair | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(plan.firstRemoved, 2)`. |
| refuses an id the history cannot place, rather than guessing | KEEP | Named contract/unique failure at this boundary; oracle: `assert.throws( () => planClaudeRollbackById({ messages: transcript, boundaries: [{ turnId: "turn-a", uuid: "h1" }], firstRemovedTurnId: "turn-unknown" }), /turn boundary is unavailable/i )`. |
| refuses a cut whose anchor a later compaction dropped | KEEP | Named contract/unique failure at this boundary; oracle: `assert.throws( () => planClaudeRollbackById({ messages: transcript, boundaries: [], firstRemovedTurnId: "h2", preservedUuids }), /compacted after that turn/i )`. |
| a turn written after a live compaction rewinds although the list never named it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(plan.rollbackAt, "a2")`. |
| drops a pair whose uuid the transcript no longer holds, so its id is refused | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(mergeClaudeTurnBoundaries(transcript, boundaries), [ { turnId: "turn-1", uuid: "h1", index: 0 }, { turnId: "h2", uuid: "h2", index: 2 }, { turnId: "h3", uuid: "h3", index: 4 } ])`. |
| orders recorded and identity boundaries by transcript index, not by record order | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(mergeClaudeTurnBoundaries(withBackground, boundaries), [ { turnId: "h1", uuid: "h1", index: 0 }, { turnId: "synthetic", uuid: "bg", index: 2 }, { turnId: "live-2", uuid: "live-2", index: 3 } ])`. |
| removing every turn yields no anchor: a fresh session, never a fork | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(plan.rollbackAt, undefined)`. |
| refuses an empty history | KEEP | Named contract/unique failure at this boundary; oracle: `assert.throws( () => planClaudeRollbackById({ messages: [], boundaries: [], firstRemovedTurnId: "h1" }), /history is unavailable/i )`. |
| accepts the minimal {threadId, resume} the §6.1 resume picker builds | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(readClaudeResumeCursor(built), { threadId: "thread-1", resume: sessionId })`. |
| accepts every id the host's own resume rule accepts | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(readClaudeResumeCursor({ resume: id })?.resume, id, id)`. |
| rejects a cursor that names a different thread | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(readClaudeResumeCursor(cursor, "thread-2"), undefined)`. |
| rejects an unusable resume, without throwing | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(readClaudeResumeCursor(bad), undefined, JSON.stringify(bad))`. |
| keeps a rollback anchor and normalises unknown boundaries to null | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(cursor?.resumeSessionAt, "a8a2167c-1111-2222-3333-444444444444")`. |
| round-trips turnBoundaries next to the legacy list | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(read, { threadId: "thread-1", resume: sessionId, turnCount: 2, turnStartMessageIds: ["fork-1", "turn-2"], turnBoundaries })`. |
| a legacy cursor without turnBoundaries still reads, and pairs each uuid with itself | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(legacy, { threadId: "thread-1", resume: sessionId, turnCount: 3, turnStartMessageIds: ["t1", null, "t3"] })`. |
| validates turnBoundaries field-wise, and never fails the cursor over them | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(cursor?.turnBoundaries, [ { turnId: "t1", uuid: "u1" }, { turnId: "t4", uuid: null }, { turnId: "t5", uuid: null }, { turnId: "t6", uuid: null }, { turnId: "t7", uuid: null } ])`. |

### `apps/daemon/src/agent-host/adapters/claude/session-tools.test.ts`

Independent source (1): Agent visuals/session-tools design2026-10-14 §§1.2–1.4; MCP wire protocol.
Stable seam (4) and refactor resistance (5): Real MCP Client + in-memory transport over the Claude SDK server; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Owns SDK-facing raw arguments, metadata, errors, cancellation and dynamic tool relisting. A host fake cannot catch SDK serialization/schema rewriting or list_changed acknowledgment.
Validation: focused Node/tsx command above with `src/agent-host/adapters/claude/session-tools.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| advertises every registered tool and calls them as its own thread | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(launch.server.type, "sdk")`. |
| forwards the arguments raw: an unknown key survives and no default is applied | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(Object.keys(listed.tools[0]!.inputSchema.properties ?? {}), ["limit", "text"])`. |
| ending the session aborts a call still in flight | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(result.isError, true)`. |
| takes a new list in-session: list_changed, answered `live` only once the client re-listed | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(launch.names().has("pixel"), true)`. |
| a client that does not re-list in time: answered truthfully (`next-idle`), never `live` | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(await applied, "next-idle")`. |
| names only the REGISTERED tools of the orquester server as session tools | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(isClaudeSessionTool("mcp__orquester__echo", names), true)`. |
| attach the in-process server, its pre-approval and its instruction block | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(Object.keys(options.mcpServers ?? {}), ["orquester"])`. |
| deny every daemon-pointing server twice: the server-level rule and deniedMcpServers (§12.1) | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(options.disallowedTools, ["mcp__orquester_remote", "mcp__my_remote"])`. |
| without session tools, nothing changes | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(options.mcpServers, {})`. |

### `apps/daemon/src/agent-host/adapters/claude/settings-env.test.ts`

Independent source (1): Native Claude settings precedence and Agent Profiles carried-runtime-settings contract; Ephemeral AI VMs§8.5.
Stable seam (4) and refactor resistance (5): claudeSettingsEnvs reading real settings/git worktrees or independent box filesystem bytes; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Owns settings hierarchy, malformed values, worktree/main-root semantics and platform-specific box resolution. Launch field tests do not read these independent files.
Validation: focused Node/tsx command above with `src/agent-host/adapters/claude/settings-env.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| a box chat reads the project's settings in the box and the user's on the host | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(claudeSettingsNodeOptions(envs), "--from-box-project")`. |
| ENABLE_TOOL_SEARCH: local over project over user over the process env | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(await setting(), { nodeOptions: undefined, toolSearch: undefined })`. |
| ENABLE_TOOL_SEARCH in a profile chat: the carried user value wins; an isolated one reads the user's only | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(claudeToolSearchSetting(loaded, {}), "auto", sources)`. |
| the local file is read at the repository root, over one left in a subdirectory cwd | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(await setting(), undefined)`. |
| a worktree's local file is its main checkout's | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(await setting(worktree), "auto")`. |
| a repository rooted at the home keeps its local file in the cwd | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(claudeToolSearchSetting(await claudeSettingsEnvs({ env, cwd, sources: "global", home }), {}), undefined)`. |
| a box chat reads the root local file on POSIX and the cwd local file on Windows | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(claudeToolSearchSetting(envs, {}), expected, platform)`. |

### `apps/daemon/src/agent-host/adapters/claude/skills.test.ts`

Independent source (1): GUI design§§4.5,4.6.2,4.6.4,4.6.8; Claude SDK question shape.
Stable seam (4) and refactor resistance (5): Filesystem skill discovery, dispatch plan and question codecs; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Owns YAML/native skill identity/precedence and raw question input/output variants absent from the single captured question and ordinary lifecycle dispatch cases.
Validation: focused Node/tsx command above with `src/agent-host/adapters/claude/skills.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| scans both roots, user first, and names a skill by its directory | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(byName.get("project-thing")?.scope, "project")`. |
| reads the two inverse invocability flags, YAML-1.1 spellings included | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(byName.get("agent-only")?.userInvocable, false)`. |
| honours skillOverrides from a lenient settings file | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(deploy.enabled, false)`. |
| only offers enabled, user-invocable skills to the dispatcher | KEEP | Named contract/unique failure at this boundary; oracle: `assert.ok(names.has("user-only"))`. |
| returns nothing rather than throwing for a missing config dir | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(skills, [])`. |
| lists the settings files in the CLI's precedence order | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(skills.find((skill) => skill.name === name)?.enabled, true, name)`. |
| lists an enabled plugin's skills as plugin:skill, and none of a disabled or uninstalled one | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( plugin.map((skill) => skill.name), ["alpha:agent-side", "alpha:review", "alpha:with-space"] )`. |
| follows the settings precedence for enabledPlugins, an extended value replacing without enabling | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(names, ["gamma:three"])`. |
| tolerates a malformed manifest or registry, and keeps a plugin's skills inside the plugin | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(names, ["declared:added", "declared:base", "my.plugin:x", "nameless:tidy", "single:solo"])`. |
| lists a plugin once, from its first install that exists, and a project install only in its project | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( inProject.filter((skill) => skill.scope === "plugin").map((skill) => [skill.name, skill.path]), [ ["dup:only", nodePath.join(installed, "skills", "only", "SKILL.md")], ["scoped:here", nodePath.join(scoped, "skills", "here", "SKILL.md")] ] )`. |
| applies a project install to a linked worktree of the same repository | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(names, ["wt:s"])`. |
| reads each account's own config dir, and CLAUDE_CODE_PLUGIN_CACHE_DIR when the CLI is given one | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(await pluginNames({ configDir: first }), ["acct:s"])`. |
| an Agent Profile's plugins replace the installed ones, named by manifest, else their directory | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( skills.filter((skill) => skill.scope === "plugin").map((skill) => skill.name), ["developer:review", "item-1:fmt"] )`. |
| a plugin whose manifest names it invalidly loads nothing, as the CLI refuses it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(await discoverClaudePluginSkills([bad]), [])`. |
| lists a profile plugin's skills under exactly the ids its skills allow-list carries | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(listed, allowed, pluginName)`. |
| accepts the YAML 1.1 booleans the CLI accepts | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(parseFrontmatterBoolean(truthy), true, truthy)`. |
| reads enabledPlugins leniently, an extended value as a replacement that enables nothing | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual([...(map ?? [])], [["a@m", true], ["b@m", false], ["c@m", null]])`. |
| drops every override in a file when one entry is invalid, as the CLI does | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(readSkillOverridesFromSettings("{ not json"), undefined)`. |
| rewrites the LAST known mention into a trailing /name block | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(plan?.skillName, "deploy")`. |
| opens the command block when the mention starts the prompt | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(plan?.leadingText, undefined)`. |
| rewrites earlier mentions inline so the model can still start them | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(plan?.skillName, "deploy")`. |
| leaves an unknown mention literal — a $HOME in prose is not a command | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(planClaudeSkillDispatch("set $HOME to /tmp", known), undefined)`. |
| keys every question on its exact text | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(parsed.questions.length, 1)`. |
| never trims or normalises the id | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(parsed.questions[0]!.id, " spaced? ")`. |
| reports two questions with identical text rather than answering one | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(parsed.duplicateQuestionText, "Same?")`. |
| builds the reply shape the SDK looks up by text | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(reply.questions, input.questions)`. |
| carries an option's preview, tagged with the format the session asked for | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(sidebar, { label: "Sidebar (Recommended)", description: "Nav on the left", preview: "┌──┬──────┐\n│ ▤│ main │\n└──┴──────┘", previewFormat: CLAUDE_QUESTION_PREVIEW_FORMAT })`. |
| drops a preview of any other shape, and an empty one, but keeps the option | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(parsed.questions[0]!.options, [ { label: "A", description: "" }, { label: "B", description: "" }, { label: "C", description: "" } ])`. |
| sends the chosen option's preview back as `annotations`, keyed by question text | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(reply.answers, { "Which layout?": "Sidebar (Recommended)", "Which features?": ["Search"] })`. |
| annotates nothing for a typed answer or an option without a preview | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal("annotations" in buildAskUserQuestionReply(input, { "Which layout?": "Something else" }), false)`. |

### `apps/daemon/src/agent-host/adapters/claude/usage.test.ts`

Independent source (1): GUI design§§4.1,4.2,4.5 token usage; Claude observed subscription/context/usage protocol.
Stable seam (4) and refactor resistance (5): Usage/window decoders at provider-data boundary; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Owns cache-token arithmetic, missing/legacy shapes, partial availability and authoritative context accounting. Replay owns live emission and uses only particular captured values.
Validation: focused Node/tsx command above with `src/agent-host/adapters/claude/usage.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| counts cache reads and writes as input | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(turn.usageStatus, "complete")`. |
| is partial when the turn did not end successfully | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(turn.usageStatus, "partial")`. |
| is unavailable when the turn produced none | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(turn.usageStatus, "unavailable", JSON.stringify(usage))`. |
| reports reasoning tokens as a subset of output | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(turn.reasoningTokens, 40)`. |
| prefers the last usage iteration for the live context reading | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(snapshot?.usedTokens, 530)`. |
| clamps the reading to the context window | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(snapshot?.usedTokens, 200_000)`. |
| reads the widest context window off the result's per-model map | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal( maxContextWindowFromModelUsage({ "claude-haiku-4-5": { contextWindow: 200_000 }, "claude-opus-4-8[1m]": { contextWindow: 1_000_000 } }), 1_000_000 )`. |
| turns a compaction boundary into before/after | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(snapshot?.lastUsedTokens, 34_995)`. |
| normalises a task usage rollup or nothing at all | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( normalizeTaskUsage({ total_tokens: 11_447, tool_uses: 1, duration_ms: 1424 }), { totalTokens: 11_447, toolUses: 1, durationMs: 1424 } )`. |
| derives a total from input + output when none is stated | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(claudeTotalProcessedTokens({ input_tokens: 3, output_tokens: 4 }), 7)`. |
| reads the captured response into §4.1's window shape | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(limits.unavailable, undefined)`. |
| clears the bars for a login with no subscription windows | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(limits.unavailable?.reason, "unsupported")`. |
| falls back to the legacy map when limits[] is absent | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( limits.windows.map((window) => window.id), ["session", "weekly_all", "weekly_scoped:fable"] )`. |
| reads both account windows off CLI 2.1.280's unifiedWindows | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(update, { windows: [ { id: "session", kind: "session", label: "Session", windowDurationMins: 300, usedPercent: 4, resetsAt: new Date(1790623200 * 1000).toISOString() }, { id: "weekly_all", kind: "weekly", label: "Weekly", windowDurationMins…`. |
| maps a streamed event onto the row the probe drew, or onto nothing | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(update?.windows[0]?.id, "session")`. |
| recognises a blocking window and its recovery | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(isRateLimitBlocking({ status: "rejected", overageStatus: "rejected" }), true)`. |
| derives the threshold from the buffer rows when the CLI reports none | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(snapshot?.autoCompactAtTokens, 1_000_000 - 33_000)`. |
| carries no threshold and says so when auto-compaction is off | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(snapshot?.autoCompactAtTokens, undefined)`. |
| falls back to maxTokens when rawMaxTokens is missing, and keeps the known total | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(snapshot?.maxTokens, 1_000_000)`. |
| refuses a malformed or empty response rather than emitting a zeroed meter | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(contextUsageSnapshot(null, undefined), undefined)`. |
| reads the real captured payload of fixture 13 | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(snapshot?.usedTokens, 15_868)`. |
| sums every model's input, output and cache counts | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(total, 1_630)`. |
| is undefined for a missing or empty map, so the caller can fall back | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(totalProcessedFromModelUsage(undefined), undefined)`. |

### `apps/daemon/src/agent-host/adapters/claude/workflow.test.ts`

Independent source (1): Claude protocol observations24 and captured workflows17–19; roster/unsafe-path guarantees.
Stable seam (4) and refactor resistance (5): Workflow wire/disk decoders and normalized/projected member events; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Owns workflow-specific task types, phase/member attribution, transcript tails and unsafe IDs/URLs; generic task/fold tests cannot recognize this external provider format.
Validation: focused Node/tsx command above with `src/agent-host/adapters/claude/workflow.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| dedupes slots and drops unsafe agent ids | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( snapshot?.agents.map((agent) => [agent.index, agent.label, agent.agentId]), [ [1, "gather:alpha", "aebd584875df53fac"], [2, "evil", undefined] ] )`. |
| maps failed and skipped agents to distinct shared states | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(status({ state: "error" }), "failed")`. |
| rejects malformed launches and unsafe session URLs | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(launch?.taskId, "wvg2ao9ra")`. |
| unwraps an agent's computed task from its transcript's first record | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(workflowAgentPromptOf(record), "Line one\n indented\nLine three")`. |
| puts the run's handles and phases on the coordinator | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(started?.payload.taskType, "local_workflow")`. |
| gives every agent slot its own member rows, in order, before the run ends | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( members.filter((event) => event.type === "task.completed").map((event) => [event.payload.taskId, event.payload.status]), [ ["wvg2ao9ra:wf:1", "completed"], ["wvg2ao9ra:wf:2", "completed"], ["wvg2ao9ra:wf:3", "completed"] ] )`. |
| stops every open member ahead of the coordinator | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(ends.slice(-4), [ "task.completed w63c5max6:wf:1 stopped", "task.completed w63c5max6:wf:2 stopped", "task.updated w63c5max6 cancelled", "task.completed w63c5max6 stopped" ])`. |
| projects the captured agent's tool call, result and answer into its drill-in once | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(owned.length, events.length)`. |
| waits for a file and for a line's newline, and survives a replaced file | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(await tail.read(), { records: [], done: false })`. |
| finds each launch by its call and its result text | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(toolUseId, "toolu_01DvgoeJ76Kfa7KTjUtk9jrY")`. |
| falls back to the journal when the run left no snapshot | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(run.status, "stopped")`. |
| projects the run's roster and each agent's conversation, owned by its member | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( taskRows(events).map(rowSummary), [ "task.started wokihcb1u", "task.started wokihcb1u:wf:1", "task.completed wokihcb1u:wf:1 completed", "task.completed wokihcb1u completed" ] )`. |
| keeps the run handles for the coordinator's start row | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(started?.payload.runHandles?.runId, "wf_68d12d28-357")`. |
| a snapshot after the run ended reopens nothing | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( taskRows(late).filter((event) => event.payload.taskId.includes(":wf:")), [] )`. |
| reads in-session history but never follows outside links or journal ids | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal((await readWorkflowHistoryRun(input)).workflowName, "inside")`. |
| reads a long line completely across concurrent reads without repeating records | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(simultaneous.records, first.records)`. |
| refuses a link, however it is named | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(await new JsonlFileTail({ path: link }).read(), { records: [], done: true })`. |

### `apps/daemon/src/agent-host/adapters/opencode/cli-inventory.test.ts`

Independent source (1): GUI design§4.5 catalogue fallbacks; observed OpenCode1.18.5 CLI stdout; shared SQLite serialization constraint.
Stable seam (4) and refactor resistance (5): loadInventoryFromCli at external process stdout/exit boundary; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): The HTTP catalogue path cannot detect CLI truncation/malformed output, optional command failures, or process-overlap locks. Native stdout and sequential execution are observed independently.
Validation: focused Node/tsx command above with `src/agent-host/adapters/opencode/cli-inventory.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| models --verbose yields providers, models and the connected list | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(list.connected.sort(), ["opencode", "openrouter"])`. |
| a body line that looks like a slug does not flush the model | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(list.connected, ["openrouter"])`. |
| an unparseable body drops that one model, never the catalogue | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(list.all.find((p) => p.id === "good")?.models["one"]?.name, "One")`. |
| empty output is an empty catalogue, not a throw | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual((await loadInventoryFromCli((await harness(t, "ok", { models: "" })).input)).providers, { all: [], connected: [] })`. |
| agent list yields name, mode and the hidden flag the CLI omits | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( agents.map((agent) => [agent.name, agent.mode, agent.hidden]), [ ["build", "primary", false], ["explore", "subagent", false], // \`title\` is always hidden in OpenCode but \`agent list\` does not say so. ["title", "primary", true] ] )`. |
| agent list tolerates an empty body and trailing whitespace | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual((await loadInventoryFromCli(h.input)).agents.map((agent) => agent.name), ["plan"])`. |
| debug skill yields name/description/location and drops the huge body | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(skills.length, 2)`. |
| a TRUNCATED skill array still yields every skill that arrived whole | KEEP | Named contract/unique failure at this boundary; oracle: `assert.throws(() => JSON.parse(cut), "the fixture really is truncated")`. |
| malformed skill output degrades to an empty list | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual((await loadInventoryFromCli(h.input)).skills, [])`. |
| the three probes run SEQUENTIALLY — concurrent runs hit one SQLite file | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(h.maxInFlight(), 1, "provider CLI processes never overlap")`. |
| a non-zero exit is retried once and recovers the catalogue sequentially | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(h.maxInFlight(), 1)`. |
| agents and skills may each degrade to an empty list | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(inventory.agents, [])`. |
| a models failure rejects — that one IS the catalogue | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects(loadInventoryFromCli(h.input), /models --verbose.*exited with code 127/)`. |

### `apps/daemon/src/agent-host/adapters/opencode/fork-session-tools.test.ts`

Independent source (1): Thread lineage/session-tools design2026-10-14 §§1.2,6; unified MCP§12.1.
Stable seam (4) and refactor resistance (5): Real adapter/server-pool/HTTP peer with independent session store and grants; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Owns the parent→child fork isolation integration and registration credentials. Pure rule builders cannot catch reuse of the parent grant or missed deny/disconnect wiring during resume.
Validation: focused Node/tsx command above with `src/agent-host/adapters/opencode/fork-session-tools.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| a fork's child registers its own server under its own grant, and its ruleset allows only that server | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(decides(fake.rulesetOf(parentSession), \`${parentName}_echo\`), "allow")`. |
| the thread's denied MCP servers are disconnected and ruled out — also without a grant (§12.1) | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(decides(fake.rulesetOf(session), "remote_list"), "deny", \`the denied server's tools (grant ${!failGrant})\`)`. |

### `apps/daemon/src/agent-host/adapters/opencode/fork.test.ts`

Independent source (1): Thread lineage design2026-10-14 §6; OpenCode fixture observation17.
Stable seam (4) and refactor resistance (5): forkOpenCodeSession external HTTP operation; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Owns exact source-cut translation and orphan cleanup when readback/refusal occurs; session rollback tests cover a distinct same-thread rewind lifecycle.
Validation: focused Node/tsx command above with `src/agent-host/adapters/opencode/fork.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| refuses a boundary the source no longer holds before creating a fork | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects( forkOpenCodeSession({ client, sourceSessionId: "ses-1", firstRemovedMessageId: "missing", directory: "/work/project" }), /message to fork from is no longer in this conversation/ )`. |
| forks with the cut's messageID and the thread's directory, then checks the count | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(id, "forked-1")`. |
| refuses a fork that did not keep exactly the cut, and deletes the session it made | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects( forkOpenCodeSession({ client, sourceSessionId: "ses-1", firstRemovedMessageId: "u2", directory: "/work/project" }), /did not preserve/ )`. |
| deletes the fork it cannot read back, and still refuses with the read's failure | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects( forkOpenCodeSession({ client: failing, sourceSessionId: "ses-1", firstRemovedMessageId: "u2", directory: "/w" }), /timed out/, "a delete that fails too never masks why the fork was refused" )`. |
| forks the whole session without a messageID | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(calls.find((call) => call.method === "POST")!.body, { directory: "/work/project" })`. |

### `apps/daemon/src/agent-host/adapters/opencode/history.test.ts`

Independent source (1): GUI design§§4.1,9; committed OpenCode GET/session/:id/message captures3,6,10.
Stable seam (4) and refactor resistance (5): OpenCodeThreadSession.readThread → projectOpenCodeHistory; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Owns historical projection through actual read interface. Live SSE normalization does not test resumed prompts, historical stamps or synthetic prompt suppression.
Validation: focused Node/tsx command above with `src/agent-host/adapters/opencode/history.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| fixture 10: the captured history replays as turn markers around completed items | CONSOLIDATE | Surviving owner now additionally checks unavailable usage, historical/thread/turn attribution and provider turn identity on this same read/projection; two repeated sessions/readbacks are removed. |
| fixture 10: every replayed turn reports usage as unavailable, never a guess | CONSOLIDATE | Absorbed into the first fixture10 projection; all turn state and unavailable-usage assertions survive. The separate run repeats identical fixture/session/read/projection setup. |
| fixture 10: every projected event is stamped historical and carries the turn id | CONSOLIDATE | Absorbed into the first fixture10 projection; all event origin/thread/turn/provider-ref/time assertions and assistant-turn identity survive. |
| fixture 10: an empty fork projects to no events at all | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(await project("thread-1", historyFor(FIXTURE_10, EMPTY_FORK)), [])`. |
| fixture 10: a replayed prompt loses the `Attached files:` block the adapter appended | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( itemsOf(await project("thread-1", messages)).map((item) => [item.payload.itemType, item.payload.detail]), [ ["user_message", "hello"], ["assistant_message", "done\n\nAttached files:\n- q3.xlsx: /a/q3.xlsx"], ["user_message", "Attached file…`. |
| fixture 10: a synthetic user text part replays as nothing, never as the user's words | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( itemsOf(events).map((item) => [item.payload.itemType, item.payload.detail]), [ // The injected prompt's turn keeps the parent's reply to it, and no "You". ["assistant_message", "alpha"], ["user_message", "Say the single word: bravo."] ] )`. |
| fixture 3: a completed tool call replays under its lifecycle type with its callID | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(tool.payload.status, "completed")`. |
| fixture 6: reasoning replays as its own item and an aborted tool call is failed | OPTIMIZE | Reuse the same projected RuntimeEvent array for event-type exclusions and item assertions; remove a second identical temporary session/read/projection inside this test. |
| fixture 10: the per-turn system addendum — session-tool instructions included — never replays | KEEP | Named contract/unique failure at this boundary; oracle: `assert.ok(user !== undefined)`. |
| fixture 10: the host's own prompt after a restart replays as nothing, never as the user's words | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( itemsOf(events).map((item) => [item.payload.itemType, item.payload.detail]), [ ["assistant_message", "alpha"], ["user_message", "Say the single word: bravo."] ] )`. |
| fixture 10: a prompt no reply names — the user sent another first — still replays as theirs | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( itemsOf(events) .filter((item) => item.payload.itemType === "user_message") .map((item) => [item.turnId, item.payload.detail]), [ [messages[1]!.info.id, "Say the single word: alpha."], ["msg_orphan", "hello"], [messages[3]!.info.id, "Say t…`. |

### `apps/daemon/src/agent-host/adapters/opencode/normalize.replay.test.ts`

Independent source (1): GUI design§§4.2,4.6,9; committed OpenCode protocol observations1–29.
Stable seam (4) and refactor resistance (5): normalizeOpenCodeEvent raw-provider event boundary; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Owns provider-specific normalization and identity/attribution; generic ingestion/fold tests cannot parse OpenCode frames, and session tests are not exhaustive grammar fixtures.
Validation: focused Node/tsx command above with `src/agent-host/adapters/opencode/normalize.replay.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| no capture produces a runtime.warning for a known-ignored frame | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( warnings.map((event) => event.payload.message), [], \`${name} warned about a known frame\` )`. |
| an unrecognised frame takes the fallback rather than a catch-all drop | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(result.events.length, 1)`. |
| a re-stated title is mirrored once, not on every session.updated | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( first.events.map((event) => event.type), ["thread.metadata.updated"] )`. |
| server.heartbeat is known and silent | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(result.events, [])`. |
| 02: text arrives as deltas and the closing snapshot emits nothing extra | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( deltas.map((event) => event.payload.delta), ["hello", " world"] )`. |
| 03: a permission ask opens a card whose workspace option names the widened pattern | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(opened.length, 1)`. |
| 03: the bash tool part runs its whole pending -> running -> completed lifecycle | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(toolEvents[0]?.type, "item.started")`. |
| 04: reject maps to decline and always maps to acceptForSession | KEEP | Named contract/unique failure at this boundary; oracle: `assert.ok(decisions.includes("decline"), \`saw ${JSON.stringify(decisions)}\`)`. |
| 05: a question opens with normalised ids and resolves with the chosen label | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(questions.length, 1)`. |
| 05: a rejected question resolves with no answers | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(resolved.at(-1)?.payload.answers, {})`. |
| 07: todos become a plan, and `field:"text"` deltas on a reasoning part stream as reasoning | KEEP | Named contract/unique failure at this boundary; oracle: `assert.ok(plans.length >= 1, "expected turn.plan.updated")`. |
| 08: an `agent: "plan"` turn emits no proposal event of any kind | KEEP | Named contract/unique failure at this boundary; oracle: `assert.notEqual(event.type, "turn.proposed.delta")`. |
| 09: session.compacted becomes thread.state.changed {compacted} | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(compacted[0]?.payload.beforeTokens, undefined)`. |
| 11: command.executed becomes a completed activity row | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(rows.length, 1)`. |
| 12: a co-tenant session's frames are dropped, not mixed into this thread | KEEP | Named contract/unique failure at this boundary; oracle: `assert.ok(sessionA !== undefined && sessionB !== undefined)`. |
| 12: a child session is a roster task: one start, one end, then the run's result | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(started.length, 1, "exactly one subagent ran in this capture")`. |
| 12: every task row repeats the whole linkage, and never stamps agentKind | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(row.payload.taskId, CHILD_SESSION_ID, row.type)`. |
| 12: the parent's `task` tool part supplies the role, the model and the tool call | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(enriched.payload.role, "explore")`. |
| 12: the child's own tool work reaches the roster as progress | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(withTool[0]?.payload.lastToolName, "bash")`. |
| 12: the child's own steps are its roster usage, and never the parent's meter | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(usages.at(-1), { totalTokens: 3538 + 3585, inputTokens: 3454 + 3544, cachedInputTokens: 0, outputTokens: 16 + 68 + 18 + 23, reasoningOutputTokens: 68 + 23, toolUses: 1 })`. |
| 12: a child's items and text are stamped with agentId; the parent's are not | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(event.payload.agentId, CHILD_SESSION_ID)`. |
| 12: the parent's own `task` row still renders as a collab-agent call | KEEP | Named contract/unique failure at this boundary; oracle: `assert.ok(taskRows.length >= 1)`. |
| 12: a child's step-finish tokens never reach the parent turn's usage summary | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(takeTurnTokenUsage(run.state, true), { usageStatus: "unavailable", usageScope: "main_agent", hasSubagents: true })`. |
| a `task_id` resume of a settled child launches it again, and its own idle settles it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(started.length, 1, "exactly one new start")`. |
| after a relaunch, a stale part of the previous call is neither a run nor its end | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(taskRows(stale), [])`. |
| a second call on a LIVE child is not a relaunch, and its end does not settle it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(taskRows(extra), [])`. |
| once a relaunched run settled, a late frame of ANY earlier call is stale | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(taskRows(late), [])`. |
| a child's title change is a progress row; a re-stated title is not (observation 19) | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(changed.length, 1)`. |
| a task part answered in the background does not settle the child it launched | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(taskRows(launch), ["task.started", "task.progress:running"])`. |
| a run gets its result once: the same part again adds nothing | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(taskRows(feed(run, childFixtureFrames([180])).flat()), [])`. |
| a resumed run's result is its own; a late part of the first call adds nothing | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( eventsOfType(perFrame.at(-1) ?? [], "task.completed").map((event) => [ event.payload.toolUseId, event.payload.summary ]), [["call_resume", second]] )`. |
| a part that errors after the child's idle gives the run its error, ending nothing | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( ends.map((event) => [event.payload.status, event.payload.summary, event.payload.toolUseId]), [["completed", failure, "call_resume"]] )`. |
| a result is the text inside the task tool's envelope; other output stands as it is | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(eventsOfType(events, "task.completed").map((event) => event.payload.summary), [expected])`. |
| a part that settles BEFORE the child's idle ends the run itself, with its result | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( ends.map((event) => [event.payload.status, event.payload.summary]), [["completed", CHILD_RESULT]], "one end, the part's, and the idle after it adds nothing" )`. |
| no result after a run the child's own session.error ended | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(taskRows(failed), ["task.completed:failed"])`. |
| a child an abort cancels ends stopped, never failed, when its own abort error or its call's cleanup beats the adapter's close — a grandchild too | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(eventsOfType(ended, "task.completed").map((event) => event.payload.status), ["stopped"])`. |
| no result after a run the host stopped | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(taskRows(closeLiveChildAgents(run.state, run.ctx, "interrupted")), [ "task.completed:stopped" ])`. |
| a background run's answer, injected into the parent, becomes its result, once | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( eventsOfType(idle, "task.completed").map((event) => event.payload.summary), [undefined], "the child's own idle ends the run with no answer yet" )`. |
| a child relaunched on the server's word still takes its own call's answer: the parent's part ends the reopened run, naming its new launch | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(revivedStarts.length, 1)`. |
| after an adapter relaunch, a provider relaunch names its own new call | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( eventsOfType(resumed, "task.started").map((event) => event.payload.toolUseId), ["call_resume"], "its own call: a changed id the roster reopens for, not the adapter's last relaunch id" )`. |
| a child whose own frames beat its launching part names the provider's call on every row once the part is read, and a relaunch still reopens it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(startsBefore.length, 1)`. |
| a child no part ever named, resumed by a `task_id` call once settled, is relaunched: a start naming the call, running, then completed with its answer | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(taskRows(first), ["task.started", "task.updated:running", "task.updated:idle", "task.completed:completed"])`. |
| a `task_id` call on a child no part named is no launch of its run: while it works, and never adopted as its call | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(eventsOfType(handed, "task.started"), [])`. |
| a background answer that arrives before the child's idle rides the run's own end | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(taskRows(early), [])`. |
| an injected envelope naming no child of this thread, or not synthetic, is no result | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(taskRows(feed(run, injectedResult("ses_somebody_else", "x")).flat()), [])`. |
| a previous background run's late answer never becomes a relaunched run's result | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( eventsOfType(events, "task.completed").map((event) => [ event.payload.toolUseId, event.payload.summary ]), [ ["call_resume", undefined], ["call_resume", CHILD_RESULT] ], "the relaunched run ends by its own idle and takes its own part's ans…`. |
| a background run takes no answer written for another run's task | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( eventsOfType(events, "task.completed").map((event) => [ event.payload.toolUseId, event.payload.summary ]), [ ["call_resume", undefined], ["call_resume", "RUN 2 ANSWER"] ] )`. |
| a reply to a prompt the host already claimed opens no new turn | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(eventsOfType(feed(run, late.begins).flat(), "turn.started"), [])`. |
| a reply with no `busy` since the parent's last idle — no run behind it — opens no turn | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(eventsOfType(lone, "turn.started"), [])`. |
| running bash parts yield chunks whose concatenation is the final output | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( chunks.map((chunk) => chunk.payload.delta), ["one\n", "two\n", "three\n"], "only what each frame appended; a re-stated value adds nothing" )`. |
| a resumed subagent's growing bash output streams under it, every chunk once | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( chunks.map((chunk) => chunk.payload.delta), ["README.md\n", "a.ts\n", "src/\n"] )`. |
| a tool that is not a command streams nothing from its metadata | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(outputChunks(events), [])`. |
| a tail window re-bases on what it keeps, and never repeats a character | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( chunks.map((chunk) => chunk.payload.delta), pieces )`. |
| a window that keeps nothing already shown is shown whole, its head marking the gap | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( chunks.map((chunk) => chunk.payload.delta), [first, windowed] )`. |
| a value that rewinds adds nothing, and the output goes on from the most shown | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( chunks.map((chunk) => chunk.payload.delta), ["one\ntwo\n", "three\n"] )`. |
| a value of no known shape shares nothing provable: it re-bases and adds nothing | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( chunks.map((chunk) => chunk.payload.delta), ["one\ntwo\n", "\ndone\n"] )`. |
| a repeating output that slides into itself loses the repeat, never shows it twice | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(chunks.map((chunk) => chunk.payload.delta), [bar])`. |
| a timeout's note reaches the stream, before the completion closes it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( chunks.map((chunk) => chunk.payload.delta), ["starting\n", "ready\n", TIMEOUT_NOTE] )`. |
| a windowed output killed at the timeout: its note reaches the joined output | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( outputChunks(events).map((chunk) => chunk.payload.delta), [...pieces, \`${TIMEOUT_NOTE}${pointer}\`] )`. |
| a cut final output closes the stream with where the whole output was saved | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( plain.map((chunk) => chunk.payload.delta), [outputWindow(printed), pointer] )`. |
| a completion whose final output the tool cut is stored marked cut; any other is not | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(stored.truncated, true, "its data keeps only the part the tool kept")`. |
| a command's completion the generic truncation cut — the head kept, its note at the end — is stored marked cut too | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(stored?.itemType, "command_execution")`. |
| a final output that neither extends the stream nor holds its end adds nothing | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( short.map((chunk) => chunk.payload.delta), ["ok\n"] )`. |
| a command that printed nothing, or failed, adds nothing at its end | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(outputChunks(silent), [])`. |
| 13: three session.error frames for one bad model collapse to one runtime.error | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(errors.length, 2, \`saw ${errors.length} runtime.error events\`)`. |
| an account failure on session.error carries a structured reason (workflows §5.4) | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(reasons(apiError(429)), [["usage_limit", undefined]])`. |
| 03: every owned step-finish reports the window it carried | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( meter.map((event) => event.payload.usage.usedTokens), [38_543, 38_490], "the numerator is the step's own total, not a running sum" )`. |
| 03: a model the catalogue never described degrades to a bare count | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(row.payload.usage.maxTokens, undefined, "never a ring against a guess")`. |
| 01: the committed /provider capture yields the meter's denominators | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(limits.get("anthropic/claude-sonnet-4-6"), 1_000_000)`. |
| 12: a child session's step-finish tokens never reach the parent's meter | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(used, [43_803, 43_950], "only the parent's own two steps")`. |
| 12: the child's start carries the prompt its launching `task` part gave it; no other task row does | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(rest, [])`. |
| a `task_id` resume's start carries the resume's own prompt, never the first launch's | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(start?.payload.toolUseId, "call_resume")`. |
| a grandchild's start carries the prompt its parent child's `task` part gave it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( eventsOfType(launched, "task.started").map((event) => [ event.payload.taskId, event.payload.description, event.payload.prompt ]), [ ["ses_child", "list files", "List every file under src/ and name the largest."], ["ses_gc", "dig deeper", "…`. |
| a start no part named yet carries no prompt, and neither does a revive of a run that already had one | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal("prompt" in (orphan?.payload ?? {}), false, "no part had said what it was asked")`. |

### `apps/daemon/src/agent-host/adapters/opencode/project-key.test.ts`

Independent source (1): OpenCode shared-project-server/account-home compatibility contract.
Stable seam (4) and refactor resistance (5): AgentAdapter.startSession; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Owns refusing unrepresentable account selection before server startup; isolated client/pool tests never receive the public home selection.
Validation: focused Node/tsx command above with `src/agent-host/adapters/opencode/project-key.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| a non-system account home is REFUSED, never silently dropped | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects( adapter.startSession({ threadId: "t", cwd: "/repo", home: { kind: "account", accountId: "acc1", path: "/homes/acc1" }, modelSelection: { model: "openrouter/x" }, runtimeMode: "approval-required" }), /cannot bind the 'account' account home/ )`. |

### `apps/daemon/src/agent-host/adapters/opencode/prompt-closed-text.replay.test.ts`

Independent source (1): Captured fixture05 question-before-closing-text race; timeline must render text once.
Stable seam (4) and refactor resistance (5): Committed capture → real normalizer → real ingestion → real fold; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Only combined decode/ingestion/fold detects duplicate visible bubbles from the late terminal snapshot. Lower-level event assertions can pass while final accumulated text duplicates.
Validation: focused Node/tsx command above with `src/agent-host/adapters/opencode/prompt-closed-text.replay.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| fixture 05: commentary closed by the question ask folds to its text exactly once | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(assistant.length, 2, "the commentary and the answer, nothing else")`. |

### `apps/daemon/src/agent-host/adapters/opencode/recycle.test.ts`

Independent source (1): Agent profile§4.8 server recycling and Agent Profiles native-key isolation.
Stable seam (4) and refactor resistance (5): Real AgentAdapter sessions + server processes + HTTP peer; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Owns lifecycle wiring: session detach without spurious exit, deferred recycling, resumed server identity and profile-key routing. Pool unit tests cannot establish thread/session consequences.
Validation: focused Node/tsx command above with `src/agent-host/adapters/opencode/recycle.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| an idle project's server is stopped now, with no session.exited, and the thread's next start gets a fresh server | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(await h.recycleIdleServers(), { recycled: 1, deferred: 0 })`. |
| a busy server is deferred, recycled once when its turn ends, and not again on later idles | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(await h.recycleIdleServers(), { recycled: 0, deferred: 1 })`. |
| a turn that reaches a recycled thread before its restart brings the session back itself | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(await h.recycleIdleServers(), { recycled: 1, deferred: 0 })`. |
| nothing running means nothing recycled; a user's session stop after a recycle forgets the thread | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(await h.recycleIdleServers(), { recycled: 0, deferred: 0 })`. |
| history reads and rewind on a recycled idle thread bring its session back (the host calls them without ensureSession) | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(await h.recycleIdleServers(), { recycled: 1, deferred: 0 })`. |
| a recycle never stops the server under a history read; it goes once the read ends | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(await h.recycleIdleServers(), { recycled: 0, deferred: 1 })`. |
| threads share a resolved project server, falling back to cwd for malformed legacy project keys | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(creates.length, 7)`. |
| a keyed thread's own catalog is its server's, never the global server's (Agent Profiles composer) | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(await h.adapter.sessionCatalog!(HOST_THREAD_ID), null, "no session")`. |
| a keyed thread runs on its own server of the project with its env, and a keyed recycle leaves the global server alone | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(h.servers.length, 2, "one global and one keyed server for the same project")`. |
| a profile switch moves the thread to the new key's server on the same upstream session; a superseded version's server is left idle | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(await h.recycleIdleServers({ poolKey: "global" }), { recycled: 1, deferred: 0 })`. |
| a profile thread runs only on its prepared version's keyed server: a start or fork without that key is refused | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects(h.start({ threadId: "p", profile }), refused)`. |

### `apps/daemon/src/agent-host/adapters/opencode/ruleset.test.ts`

Independent source (1): GUI design§§4.3,4.4,4.6.3/5; OpenCode native permission rules and directory-scoped always grants.
Stable seam (4) and refactor resistance (5): Permission rules/replies and synthesized provider snapshot boundary; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Owns policy tables, sensitive reads, canonical request types and unsupported command/model exposure. Session tests cover representative dispatch and cannot enumerate every safe permission mode.
Validation: focused Node/tsx command above with `src/agent-host/adapters/opencode/ruleset.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| §4.3: every decision maps to the reply the OpenCode column names | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(toOpenCodePermissionReply(decision), expected, \`decision ${decision}\`)`. |
| §4.3: the card falls back to the default four when the ask names no patterns | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( options.map((option) => option.decision), ["accept", "acceptForSession", "decline", "cancel"] )`. |
| §4.3: a permission maps to a canonical request type | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(mapPermissionToRequestType("read"), "file_read_approval")`. |
| §4.4 full access: `*`→allow plus an explicit external_directory allow | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(rules, [ { permission: "*", pattern: "*", action: "allow" }, { permission: "external_directory", pattern: "*", action: "allow" } ])`. |
| §4.4 supervised: `*`→ask, reads allow except `.env` | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(ruleFor(rules, "*"), "ask")`. |
| §4.4 accept edits permits edits while shell and sensitive reads still ask | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(ruleFor(rules, "edit"), "allow")`. |
| §4.4 auto keeps supervised approval for edits, shell and sensitive reads | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(ruleFor(rules, "*"), "ask")`. |
| §4.4: the read-only and always-allowed tools are exactly the documented set | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(ruleFor(rules, permission), "allow", \`${permission} must be allowed\`)`. |
| §4.6.3: a real command list keeps `/compact` first and drops skill-sourced rows | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( commands.map((command) => command.name), ["compact", "fixture"], "skill rows reappear as skills; a provider \`compact\` never shadows the host one" )`. |
| R2-11: a not-installed snapshot advertises no `/effort` either | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( snapshot.slashCommands.map((command) => command.name), ["compact"] )`. |

### `apps/daemon/src/agent-host/adapters/opencode/server.test.ts`

Independent source (1): GUI design§§3.1–3.2,9; observed OpenCode readiness/auth/multiplexing; keyed profile server contract.
Stable seam (4) and refactor resistance (5): OpenCodeServerPool with real spawned peer and HTTP health requests; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Owns process startup/auth/refcount/idle-death/recycle/key partitioning. Adapter/session fakes do not establish real child supervision and physical server ownership.
Validation: focused Node/tsx command above with `src/agent-host/adapters/opencode/server.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| recycle (agent profile §4.8) stops only an unheld server, and the next start waits for the old child to be gone | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(pool.recycle(peer.dir), null, "a held server is never recycled")`. |
| `/global/health` is reached WITH the credential, as the real server demands | KEEP | Named contract/unique failure at this boundary; oracle: `assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+$/)`. |
| a server below the minimum is REFUSED with the required version in the message | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects(pool.acquire(peer.dir), (error: unknown) => { assert.ok(error instanceof Error); assert.match(error.message, /1\.10\.0 is too old/); assert.match(error.message, /1\.14\.19/); return true; })`. |
| an unhealthy server is refused rather than adopted | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects(pool.acquire(peer.dir), /invalid health response/)`. |
| a peer that dies before printing a ready line fails with its stderr excerpt | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects(pool.acquire(peer.dir), (error: unknown) => { assert.ok(error instanceof Error); assert.match(error.message, /exited with code 3/); assert.match(error.message, /mock peer: fatal error/); return true; })`. |
| a bad binary fails the acquire instead of hanging | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects(pool.acquire(peer.dir), /failed to spawn\|ENOENT/)`. |
| a host abort cancels acquisition of a silent peer | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects(pool.acquire(peer.dir))`. |
| threads of one project share one server, ref-counted, closed after the last release | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(first.pid, second.pid, "one \`opencode serve\` per project")`. |
| a re-acquire inside the idle window cancels the close | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(second.pid, first.pid, "the parked server was reused")`. |
| two projects get two servers | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(pool.list().length, 2)`. |
| concurrent acquires for one project collapse onto a single start | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(new Set(handles.map((handle) => handle.pid)).size, 1)`. |
| a dead server is not reported as live by pool.list() | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(pool.list().length, 1)`. |
| a second stopAll waits for the first's kills: the host's two teardown calls both return only once the servers are gone | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(handle.hasExited(), true, "the second call resolved only once the server was gone")`. |
| two keys of one project are two servers, one key is shared, and a key's env reaches only its own server | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(global.poolKey, OPENCODE_GLOBAL_POOL_KEY)`. |
| recycle and the idle close act per (project, key): the project's other server is untouched | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(pool.recycle(peer.dir, "profile-a"), null, "a held keyed server is never recycled")`. |
| a keyed server whose child crashed is restarted on the next acquire of that key only | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(pool.isWarm(peer.dir, "profile-a"), false)`. |
| a spec the pool cannot apply as written is refused, and leaves no server behind | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects(pool.acquire(peer.dir, { key: OPENCODE_GLOBAL_POOL_KEY }), /reserved/)`. |
| a key reused with a different env keeps the running server and warns | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(second.pid, first.pid)`. |

### `apps/daemon/src/agent-host/adapters/opencode/session-tools.test.ts`

Independent source (1): Session-tools design§1.2; OpenCode native last-matching permission/subagent rule semantics; unified MCP§12.1.
Stable seam (4) and refactor resistance (5): Rules delivered to provider evaluated against independent offered tool IDs; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Owns wildcard collisions, co-tenant/subagent hiding and external-server compatibility across permission modes. A single adapter registration scenario does not enumerate native rule evaluation.
Validation: focused Node/tsx command above with `src/agent-host/adapters/opencode/session-tools.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| the server name is fixed-width, stable and the thread's own | KEEP | Named contract/unique failure at this boundary; oracle: `assert.match(a, /^orquester-[0-9a-f]{16}$/)`. |
| `thread A is offered its own tools and never thread B's (${mode})` | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual([...hiddenFromA].sort(), [toolId(serverB, "echo"), toolId(serverB, "task_status")].sort())`. |
| every tool of a denied server is dropped, its own tools kept (§12.1) | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual([...hidden].sort(), [toolId("orquester", "send_message"), toolId("remote_api", "list")].sort())`. |
| a thread whose own grant failed is still kept off every co-tenant's tools | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual([...hidden], [toolId(serverA, "echo")])`. |
| the external /mcp under the name docs/orquester-mcp.md suggests keeps every tool | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual([...offered(SUGGESTED_EXTERNAL_NAME)], [])`. |

### `apps/daemon/src/agent-host/adapters/opencode/session.test.ts`

Independent source (1): GUI design§§3.1–3.4,4.1–4.6,5.5; observed OpenCode completion/abort/child/background/request protocols.
Stable seam (4) and refactor resistance (5): OpenCodeThreadSession operations/events against raw SSE and HTTP inputs; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Owns concurrent stateful races and wire side effects. Pure normalization and pool tests do not submit/settle operations, reconcile status or fence late frames during abort/reconnect.
Validation: focused Node/tsx command above with `src/agent-host/adapters/opencode/session.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| a fresh session is created WITH the ruleset in the create body | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(body.permission?.[0]?.permission, "*")`. |
| resume in the same directory reuses the session and RE-ASSERTS the ruleset | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(harness.fake.find("POST", "/session"), undefined, "must not create a session")`. |
| resume against a confirmed 404 falls through to a fresh session | KEEP | Named contract/unique failure at this boundary; oracle: `assert.ok(harness.fake.find("POST", "/session") !== undefined)`. |
| resume against a 500 PROPAGATES — a blip must never reset a live thread | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects( startSession(harness, { resumeCursor: { schemaVersion: 1, sessionId: "not-a-session-id" } }), /500/ )`. |
| a cursor carrying unknown extra fields still resumes | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(session.sessionId, "ses_old")`. |
| a cursor of the wrong shape means `no resume`, never an error | KEEP | Named contract/unique failure at this boundary; oracle: `assert.ok(harness.fake.find("POST", "/session") !== undefined)`. |
| a cwd change forks rather than minting an empty session | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(harness.fake.find("POST", "/session"), undefined)`. |
| a turn submits prompt_async with a minted id, the system addendum and the variant | KEEP | Named contract/unique failure at this boundary; oracle: `assert.match(body.messageID, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)`. |
| an xlsx rides as a path line in the text part; a csv is still a native file part (§4.5) | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(body.parts.length, 2)`. |
| an attachment-only turn with a non-native file no longer throws: the block is the text | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(body.parts, [ { type: "text", text: "Attached files:\n- q3.xlsx: /attachments/att-x" } ])`. |
| a text file over the native cap rides as a path line, not a file part (§4.5) | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual((submit.body as { parts: unknown[] }).parts, [ { type: "text", text: "read this\n\nAttached files:\n- huge.log: /attachments/att-big" } ])`. |
| an attachment whose path cannot be resolved fails the turn instead of vanishing | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects( session.sendTurn({ threadId: "thread-1", input: "summarise this", attachments: [{ type: "file", id: "att-gone", name: "q3.xlsx", sizeBytes: 10 }], interactionMode: "default" }), /removed or expired/ )`. |
| plan mode rides the `agent` field, per turn | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal((submit?.body as { agent?: string }).agent, "plan")`. |
| a turn completes on idle, with accumulated usage and cost | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(completed.turnId, turn.turnId)`. |
| the premature-idle race still completes the turn (machine 3) | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(completed.turnId, turn.turnId)`. |
| a second sendTurn during a live turn STEERS: same turn id, one turn.started | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(second.turnId, first.turnId, "steering reuses the active turn id")`. |
| a refused submit settles the turn as failed rather than leaving it running | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects( session.sendTurn({ threadId: "thread-1", input: "hi", attachments: [], interactionMode: "default" }) )`. |
| a name in `command.list` is dispatched through session.command | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(submitted, undefined, "a native command must not go through prompt_async")`. |
| a name that is NOT in `command.list` falls through to an ordinary prompt | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual((submit.body as { parts: unknown[] }).parts, [ { type: "text", text: "/definitely-not-a-command hi" } ])`. |
| a native command with a non-native file carries the path block in its arguments (§4.5) | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal( harness.fake.find("POST", "/prompt_async"), undefined, "a native command must not go through prompt_async" )`. |
| an approval reply reaches `POST /permission/{id}/reply`, never the SDK trap route | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(reply.body, { reply: "always" })`. |
| a redirecting decline rejects WITH the redirect message; a plain decline rejects bare | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( reply?.body, redirect ? { reply: "reject", message: APPROVAL_REDIRECT_MESSAGE } : { reply: "reject" } )`. |
| a child session's permission names its subagent, and a decline with the user's words rejects with them | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(opened.payload.requestingAgentId, "ses_child")`. |
| interrupt is turn-scoped: a Stop on a settled turn cannot kill the next one | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(harness.fake.find("POST", "/abort"), undefined, "a stale Stop is a no-op")`. |
| a question is answered on its reply route and dismissed on its reject route | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(asked.payload.questions[0]?.id, "question-0-colour-preference")`. |
| compaction is REFUSED while a turn runs — the server has no such backstop | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects(session.compact(), /cannot compact while a turn is running/)`. |
| compaction on an idle session posts summarize with auto:false | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(summarize?.body, { providerID: "openrouter", modelID: "google/gemini-2.5-flash-lite", auto: false })`. |
| rollback forks, verifies the boundary count, re-applies the ruleset and re-points | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(session.resumeCursor.sessionId, session.sessionId)`. |
| rollback refuses when the fork did not preserve the boundary | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects(session.rollbackThread(1), /did not preserve the requested rewind/)`. |
| rollback by turn ID forks at the NAMED turn's prompt, wherever the count points | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal( (fork?.body as { messageID: string }).messageID, "msg_p2", "the fork lands on the prompt that opens the named turn" )`. |
| a live turn is named by the prompt that opened it, so a rewind finds it again | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(turn.turnId, promptId, "the turn id IS the OpenCode id of its opening prompt")`. |
| rollback refuses a turn ID the session no longer holds, before forking anything | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects( session.rollbackThread(1, { firstRemovedTurnId: unknown, droppedTurnIds: [unknown], retainedTurnIds: ["msg_a1", "msg_a2"] }), /opencode: the turn to rewind to is no longer in this session/ )`. |
| a second rewind finds a turn the first one kept, under the fork's re-minted ids | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(kept.length, 4)`. |
| a live subagent is closed `stopped` before session.exited | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(started.payload.taskId, "ses_child")`. |
| a child session's question rides no turn, and so does its answer; the parent's own ride its turn | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(child.turnId, undefined, "the child's question rides no turn")`. |
| interrupting a turn closes its subagents too | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(completed[0]?.payload.status, "stopped")`. |
| §6.2: an interrupt with NO active turn still stops all background work | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(session.hasLiveSubagents(), true, "the subagent outlived the turn")`. |
| §6.2: a session-scoped interrupt with nothing live is a clean no-op | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(session.hasLiveSubagents(), false)`. |
| stop is idempotent and emits exactly one session.exited | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal( eventsOfType(harness.events, "session.exited").length, 1 )`. |
| a background answer wakes the parent: its reply runs as a turn named by the injected prompt, and the run's idle settles it | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(started.map((event) => event.turnId), ["msg_injected"])`. |
| a session.error during the woken reply fails its turn, as it fails any | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( [completed.turnId, completed.payload.state, completed.payload.errorMessage], ["msg_injected", "failed", "Rate limit exceeded"] )`. |
| the user's message during the woken reply steers it: one turn, which the run's idle ends | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(steer.turnId, "msg_injected", "the server queues it into the same run")`. |
| a second answer that arrives while the woken reply runs joins its turn: one turn, one completion | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(completed.turnId, "msg_injected")`. |
| a Stop during the woken reply aborts its turn, and what the aborted run still sends opens nothing | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(aborted?.turnId, "msg_injected")`. |
| a Stop's leftovers end once a later turn fails: a background answer after it still wakes the parent into a turn | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal((failed as Extract<RuntimeEvent, { type: "turn.completed" }>).payload.state, "failed")`. |
| a rewind ends a relaunched child the fork leaves behind: aborted, its call and then its run closed, and nothing of it comes back | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal((await revival).turnId, undefined, "relaunched between turns")`. |
| a rewind closes a left-behind child's calls on the turns it keeps only: a call whose rows ride a removed turn goes with them, and leaves no lone closer | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( eventsOfType(rewound, "item.completed") .map((event) => \`${event.itemId}@${event.turnId === kept ? "kept" : event.turnId === undefined ? "no turn" : event.turnId}\`) .sort(), ["call_a@kept", "call_c@no turn", "call_d@kept"], "B's only rows …`. |
| a rewind ends a background child still running between turns: aborted, closed, and the drain released | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(livenessOf(harness).liveness("thread-1"), "working")`. |
| a child whose abort frames beat the Stop's own close ends stopped — its own abort error, or its call's cleanup — never failed | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( taskEnds(harness.events), [first === "its abort error" ? "ses_fg:stopped:Aborted" : "ses_fg:stopped:Tool execution aborted"], \`${first}: one end, stopped — the Stop's close found it ended\` )`. |
| a background child outlives its launching turn's failure — running in the roster and in liveness — and ends by its own idle and answer | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(taskEnds(harness.events), [], "the failed turn closes no background run")`. |
| a foreground child of a failed turn is still closed stopped | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(taskEnds(harness.events), ["ses_fg:stopped:Rate limit exceeded"])`. |
| a Stop closes every child — a background one too: the abort cancels its job | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(taskEnds(harness.events).sort(), ["ses_bg:stopped:interrupted", "ses_fg:stopped:interrupted"])`. |
| a child that survives the Stop is relaunched on the server's word: the roster reads it running, then completed with its own answer | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(livenessOf(harness).liveness("thread-1"), null, "closed, it held no drain")`. |
| a second Stop closes a relaunched child, and a confirmed report relaunches it again under its next id | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(taskEnds(harness.events.slice(fed)), ["ses_bg:stopped:interrupted"], "the relaunched run is in the live set: the Stop closes it")`. |
| a NESTED subagent that survives the Stop is relaunched too: its first start names its call, and it reads running, then completed with its own answer | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(first.payload.toolUseId, "call_gc", "its FIRST start names a launch: the child's own call")`. |
| after a failed admission a relaunched child holds the drain, but reads interrupted: that session reads error, which the roster takes for dead | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(taskEnds(harness.events).map((row) => row.split(":").slice(0, 2).join(":")), ["ses_bg:stopped"])`. |
| a child the Stop ended sends its leftovers: the server says it runs nothing, and it stays ended | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(statusReads() - readsBefore, 1, "one question for the whole burst")`. |
| a child the Stop closed that reports while the server cannot say counts live again: the drain outranks a duplicate row | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(livenessOf(harness).liveness("thread-1"), "working")`. |
| a report from a child the Stop closed, arriving while a later Stop is under way, is judged after that Stop: its abort may end the child | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal( harness.fake.requests.filter((request) => request.path === "/session/status").length, readsBefore, "no question to the server while the abort that may end the child is under way" )`. |
| a Stop that begins and ends while the server is asked about a child makes that answer stale: it asks again, and does not relaunch a child it ended | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( harness.events.slice(fed).filter((event) => event.type === "task.started"), [], "the second answer is the one that counts: the Stop ended it" )`. |
| a child whose own idle arrives while the server is asked about it is not revived: that report was its last | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(harness.events.slice(fed).filter((event) => event.type.startsWith("task.")), [])`. |
| the session stopping during the woken reply settles its turn before session.exited | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual([completed?.turnId, completed?.payload.state], ["msg_injected", "interrupted"])`. |
| the host's own /compact runs no turn: its summary streams while summarize runs, and opens nothing | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(eventsOfType(harness.events, "turn.started"), [])`. |
| a woken run that compacts first runs as one turn from its summary on, which the run's idle settles | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( eventsOfType(harness.events, "turn.started").map((event) => event.turnId), ["msg_compaction"], "the thread reads working through the compaction" )`. |
| a rewind's fork is the past: its copied messages, delivered late, open no turn | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(eventsOfType(harness.events, "turn.started"), [])`. |
| after a Stop, a background answer's run is a new run: its reply is written on its own woken turn, the stopped run's late frames still dropped | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(timelineRows(harness.events, fed), [], "the stopped run's late frames write nothing")`. |
| after a Stop, a new run whose busy arrives before the abort answers still gets its woken turn once the abort is over | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal((woken as Extract<RuntimeEvent, { type: "turn.completed" }>).payload.state, "completed")`. |
| while a Stop is under way, a run the abort then cancels says busy after an idle: its reply opens no turn, before the abort answers or after | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(timelineRows(harness.events, fed), [], "no turn for a run the abort under way may end")`. |
| when the stream wins the race and the boundary is crossed early, the cancelled run's own abort error is an echo: no failure, no error | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(eventsOfType(harness.events.slice(fed), "runtime.error"), [], "the echo of an abort is no provider error")`. |
| the echo is expected only until the parent's next idle, in either spelling: after a real new run, an abort error nobody here sent is reported | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal((reported as Extract<RuntimeEvent, { type: "runtime.error" }>).payload.message, "Aborted", idle)`. |
| a host turn sent after a Stop is no abort's victim: an abort error mid-turn fails it, whichever of its busy and its prompt's answer comes first | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( eventsOfType(harness.events.slice(fed), "turn.completed").map((event) => [event.turnId, event.payload.state]), [[next.turnId, "failed"]], \`${order}: the turn's own abort is the provider's word\` )`. |
| an abort error that may still be the Stop's echo fails no host turn: before the stopped run's idle came, or before the turn's prompt was taken | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(eventsOfType(harness.events.slice(fed), "runtime.error"), [], title)`. |
| after a Stop whose abort request failed, an abort error before the run's idle is still the Stop's echo: it fails nothing, and the idle then ends the turn as the Stop would have | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects(session.interruptTurn(stopped.turnId))`. |
| a Stop whose abort request failed: the stream's or the server's word that the run ended settles the turn as the abort would have — two idle frames or a lone one, before the failure or after it, or a reconnect's status poll; without that word, the next Stop asks the server again — and the next run is a new one | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects(session.interruptTurn(stopped.turnId))`. |
| a steer after a failed Stop takes the turn back: the run's own end completes it, and the background work it started runs on | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects(session.interruptTurn(stopped.turnId))`. |
| the end of a Stop whose abort request failed closes the children, then aborts them: a child's report in between asks the server only once that abort is over, so a child it ends is never relaunched — the run's idle or a reconnect's status poll | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(taskEnds(harness.events), ["ses_bg:stopped:interrupted"], \`${end}: closed on the Stop's word, before its abort\`)`. |
| the end of a Stop whose abort request failed: a request from a child that end is aborting is judged after that abort — an ask it ends gets no card | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(harness.fake.find("GET", "/permission"), undefined, "no question to the server while the abort that may end its asker is under way")`. |
| a child's report the server is being asked about when a failed Stop's run ends is asked about again once that end's abort is over: the answer from before it is stale | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects(session.interruptTurn(next.turnId))`. |
| after a Stop, a busy from before the stopped run's idle ends nothing: a reply to an unclaimed prompt after it still opens no turn | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(timelineRows(harness.events, fed), [], "no idle since the Stop: that busy may be the stopped run's own")`. |
| a reconnect clears a stale busy: a reply the host never started, after the gap, opens no turn | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(eventsOfType(harness.events, "turn.started"), [], "a busy from before the gap opens nothing")`. |
| a reconnect keeps what a live run says after it: a busy after the gap still opens the woken turn | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( eventsOfType(harness.events, "turn.started").map((event) => event.turnId), [FIRST.promptId], "the run's own busy after the gap is the evidence" )`. |
| after a Stop, a question from a child the abort never reached is shown on no turn, and its answer reaches the server | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(asked.requestId, "que_survivor")`. |
| after a Stop, a live asker's approval is shown — on the turn running then, none here — and answered on its reply route | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual([opened.requestId, opened.turnId], ["per_survivor", undefined])`. |
| after a Stop, a request whose asker the abort ended is rejected on the wire and writes no card — nor a row when it closes | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(rejectedAsk.body, { reply: "reject" })`. |
| after a Stop, a request answered elsewhere while the server is asked about it is dropped: no card, no row, nothing sent | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( eventsOfType(harness.events, type).filter((event) => event.requestId === "per_elsewhere"), [], \`no ${type} for a request someone else answered\` )`. |
| after a Stop, an older server's orphan — still listed, its session idle — is rejected too, and shown nowhere | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(rejected.body, { reply: "reject" })`. |
| a request that arrives while the Stop's abort is in flight is judged after it: an asker the abort ended gets no card on the stopped turn | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(eventsOfType(harness.events, "request.opened"), [], "no card while the abort may still end its asker")`. |
| a request that arrives once the next turn is sent, before its run says busy, is judged too: the stopped run's leftover is no card on the new turn | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(rejected.body, { reply: "reject" })`. |
| an ask that arrives while the Stop withdraws the parked cards is held too: judged after the abort, no card on the stopped turn | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( eventsOfType(harness.events, "request.opened").filter((event) => event.requestId === "per_during_settle"), [], "no card while the Stop is under way" )`. |
| after a prompt admission fails and aborts the session, a request is judged as after a Stop: the aborted run's is rejected, a live asker's shown | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal((failed as Extract<RuntimeEvent, { type: "turn.completed" }>).payload.state, "failed")`. |
| a Stop that begins and ends while the server is asked about a held request makes that answer stale: it asks again | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(rejected.body, { reply: "reject" }, "asked again after that Stop: its asker is gone")`. |
| after a Stop, a request the server cannot say anything about is shown: the user answers it, never a reject on their behalf | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(opened.requestId, "per_unknown")`. |
| full access: a live asker's request after a Stop is answered once, as any; a reply the server refuses shows the card once | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(auto.body, { reply: "once" }, "never always: full access answers once")`. |
| full access: an automatic reply the server refuses falls back to the card while a turn runs | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(opened.requestId, "per_refused")`. |
| malformed model selections fail before opening or submitting a turn | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects(session.sendTurn({ threadId: "thread-1", input: "hi", attachments: [], interactionMode: "default", modelSelection: { model } }), /provider\/model/)`. |
| answers prefer question ids, then headers, then question text, preserving multiple selections | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(harness.fake.find("POST", "/question/que_1/reply")?.body, { answers: [["Red"], ["one", "two"], ["done"]] })`. |
| Q1 #21: a co-tenant thread's ask is probed ONCE, not polled forever | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(probeCount(harness, "ses_cotenant"), 1, "a walked foreign root is not retried")`. |
| Q1 #21: an unreadable session is retried, but the chain is CAPPED | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(probeCount(harness, "ses_unreadable"), 5, "the unknown outcome is retried, up to the cap")`. |
| Q1 #21: closing the thread abandons an in-flight ancestry chain | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(probeCount(harness, "ses_gone"), 1, "one probe, unknown: the chain waits to retry")`. |
| a stop withdraws every parked card, once each | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(firstOfType(harness.events, "turn.completed")?.payload.state, "interrupted")`. |
| an interrupt withdraws every parked card, once each | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(closingsOf(harness, "per_1").length, 1, "the stop finds nothing left to close")`. |
| a dead server withdraws every parked card once, before session.exited | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(firstOfType(harness.events, "turn.completed")?.payload.state, "failed")`. |
| the user's own answers are never withdrawn — and the server's echo adds no row | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(approval.length, 1)`. |
| session tools: the thread's own server is registered before its session, isolated by its ruleset | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(register?.body, { name: launch.serverName, config: { type: "remote", url: launch.url, headers: { Authorization: launch.authorization }, oauth: false, enabled: true, // A call may wait for the user (\`request_secret\`): past the MCP SDK's 60 s…`. |
| session tools: a resumed session gets the isolation rules re-asserted | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( patch.permission.slice(-2).map((rule) => rule.permission), ["orquester-????????????????_*", \`${launch.serverName}_*\`] )`. |
| session tools: a failed registration costs the tools, never the thread | KEEP | Named contract/unique failure at this boundary; oracle: `assert.ok(harness.fake.find("POST", "/session"), "the session still opened")`. |
| session tools: a thread whose grant failed still sends the deny, and no allow | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(harness.fake.find("POST", "/mcp"), undefined, "nothing of its own to register")`. |
| session tools: a denial by disconnect alone (an overlapping name) is re-asserted at every turn start, and ruled once it cannot be | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(ruledOut(create.permission), false, "exact: no over-wide rule while the disconnect holds")`. |
| session tools: a rule whose send failed is not taken as sent — the next turn start sends it again | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects(session.sendTurn({ threadId: "thread-1", input: "hello", attachments: [], interactionMode: "default" }))`. |
| session tools: stop waits for the pending disconnect before a relaunch can proceed | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(stopped, false, "the stop waits for its disconnect")`. |
| without session tools nothing is registered and the ruleset is unchanged | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(harness.fake.find("POST", "/mcp"), undefined)`. |

### `apps/daemon/src/agent-host/adapters/opencode/snapshot-budget.test.ts`

Independent source (1): Historical E9 first cold refresh failure; GUI design§§4.5,4.6.4; observed warm server reuse and binary update cache invalidation.
Stable seam (4) and refactor resistance (5): AgentAdapter.refreshSnapshot with real spawned peer / CLI fallback; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Owns adapter budget/readiness/cache integration; pool tests establish process behavior but cannot catch an adapter returning before catalogue completion or retaining unread/updated binary snapshots.
Validation: focused Node/tsx command above with `src/agent-host/adapters/opencode/snapshot-budget.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| E9: a COLD probe waits for the server to report ready, then reads the catalogue | CONSOLIDATE | Surviving owner verifies cold readiness/catalogue then immediately performs warm refresh under equivalent cwd spelling; preserves both previously separate contracts using one child/server fixture. |
| E9: the second probe is warm — the start cost is paid once per project | CONSOLIDATE | Absorbed into cold→warm owner; one-server count, ready result, cwd canonicalization and race against second startup remain. The removed cold setup provided no independent protection. |
| R4 #7: the cwd-less refresh reads the CLI catalogue without creating a session | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(snapshot.installed, true)`. |
| E9: a catalogue failure degrades the snapshot while retaining available skills | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(snapshot.installed, true)`. |
| an unread version is not served from the cache: the next refresh reads it again | KEEP | Named contract/unique failure at this boundary; oracle: `assert.match(unread.message ?? "", /Could not read an OpenCode version/)`. |
| an update that rewrites the binary is re-probed, not answered from the TTL cache | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(before.version, MINIMUM_OPENCODE_VERSION)`. |

### `apps/daemon/src/agent-host/adapters/opencode/snapshot.test.ts`

Independent source (1): Provider models contextWindow/limit.context public contract for meter and handoff.
Stable seam (4) and refactor resistance (5): buildSnapshot and modelContextLimits on independent catalogue data; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Owns forwarding context windows and omission for unknown/nonpositive limits to both public model metadata and meter denominators. Captured real-model meter test alone has no missing/zero-limit examples.
Validation: focused Node/tsx command above with `src/agent-host/adapters/opencode/snapshot.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| each connected model carries its `limit.context` as its context window, when it states one | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( models.map((model) => [model.slug, model.contextWindow]), [ ["local/nolimit", undefined], ["local/small", 32_768], ["local/zero", undefined] ] )`. |

### `apps/daemon/src/agent-host/adapters/opencode/sse.test.ts`

Independent source (1): Server-Sent Events framing/UTF-8 stream contract and fetch-body resource cleanup.
Stable seam (4) and refactor resistance (5): readSseFrames on independent byte streams; assertions observe its returned public data, recorded external bytes, errors or RuntimeEvents rather than private method layout.
Unique protection (6): Captured fixtures already store decoded frames, so only this parser owner catches multiline/chunk/BOM/comment framing and cancellation leaks.
Validation: focused Node/tsx command above with `src/agent-host/adapters/opencode/sse.test.ts` (live isolation additionally needs its explicit environment opt-in).

| Original case (specific failure2) | Disposition | Oracle3 / reason |
| --- | --- | --- |
| a frame split across chunk boundaries is reassembled | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( frames.map((frame) => frame.data), ["hello world"] )`. |
| multi-line data is joined with newlines, per the SSE spec | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(frames[0]?.data, "line one\nline two\nline three")`. |
| `:`-comment keep-alives produce no frame and do not break the next one | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( frames.map((frame) => frame.data), ["real"] )`. |
| CRLF line endings decode the same as LF | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(frames[0]?.data, "payload")`. |
| one leading space after the colon is stripped, further ones are data | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(frames[0]?.data, " two spaces")`. |
| a field with no colon, and unknown fields, are ignored | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual( frames.map((frame) => frame.data), ["kept"] )`. |
| a blank line with no data emits nothing | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(await framesFrom(["\n\n", "event: lonely\n\n"]), [])`. |
| an unterminated trailing frame is NOT emitted until its blank line | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(await framesFrom(["data: pending\n"]), [])`. |
| a BOM is stripped once, at the start of the STREAM | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(frames.map((frame) => frame.data), ["first"])`. |
| a BOM mid-stream is preserved verbatim in the data | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(frames.map((frame) => frame.data), ["first", "\uFEFFbom-inside"])`. |
| readSseFrames yields every frame and ends at EOF | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(seen, ["a", "b"])`. |
| readSseFrames CANCELS the body when the consumer breaks out | KEEP | Named contract/unique failure at this boundary; oracle: `assert.equal(frame.data, "a")`. |
| readSseFrames cancels the body when the consumer throws | KEEP | Named contract/unique failure at this boundary; oracle: `assert.rejects( (async () => { for await (const frame of readSseFrames(body)) { void frame; throw boom; } })(), (error: unknown) => error === boom )`. |
| readSseFrames on a null body ends immediately | KEEP | Named contract/unique failure at this boundary; oracle: `assert.deepEqual(seen, [])`. |
