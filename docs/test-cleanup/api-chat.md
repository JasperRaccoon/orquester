# API agent-chat test cleanup

Status: completed scoped cleanup. The disposition ledger was recorded before the corresponding edits; final verification is below.

Scope: all 21 original `packages/api/src/agent-chat/*.test.ts` files, 273 test declarations / 275 runtime cases (two two-case parameterized declarations). Tests and corresponding production owners were read before these dispositions. No source-grep, markup snapshot, mock-implemented contract or timing-based test was retained.

Independent sources: [GUI design](../superpowers/specs/2026-09-21-agent-chat-gui-design.md), [fold-performance design](../superpowers/specs/2026-09-23-fold-performance-design.md), [thread-index design](../superpowers/specs/2026-09-23-thread-index-and-lazy-boot-design.md), [goals design](../superpowers/specs/2026-09-24-agent-goals-design.md), [workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md), and repository AGENTS.md. Source comments documenting actual persisted-provider shapes and concrete prior incidents are used as regression evidence, not arbitrary declarations as their own oracle.

For each KEEP/REWRITE below the six-bar justification is the file rationale plus the individual failure row: **1** named independent contract/incident; **2** concrete caller-visible failure in that row; **3** fixture literals or independently specified storage-preservation invariants, never an expected value obtained by calling the subject; **4** listed public data interface/stable seam; **5** no private call ordering, source shape or collaborator identity, so a behavior-preserving refactor preserves the assertion; **6** listed owner is the lowest shared contract boundary, with redundant cases deleted and higher GUI/MCP copies delegated to their owning audit. Snapshot round trips protect serialization fidelity, not agreement between two equivalent folds. Retention limits describe stored/served history windows, not visual row geometry.

Risk for deletions: low; each row names its remaining owner. Retained contracts are mostly protocol/storage compatibility and therefore high consequence if removed. No production runtime behavior changes are needed here. Focused validation for every row: `pnpm exec node --import tsx --import ../../scripts/test/assert-ok.mjs --test src/agent-chat/<file>.test.ts` from `packages/api`; full scoped command uses `src/agent-chat/*.test.ts`. Package typecheck follows seam removal.

Baseline: scoped suite passed **275/275**, zero failures (96.75 s). An initial command issued from the root via `pnpm --filter ... exec` did not expand the relative shell glob; rerunning from `packages/api` supplied the intended 21 files.

Planned seam/support cleanup: delete unused `deriveLatestTurn` and its type import; stop exporting `summarizeToolTextOutput`, `requestKindFromRequestType`, and `parseQuestions` (all have only local production callers). Retained shared `test-helpers.ts` builders still have many real contract tests. No fixture or snapshot file is exclusive to a deleted test.

## `command-output.test.ts`

Owner: `command-output.ts` (contracts also use `wire.ts`/`runtime-events.ts`; goal capability parsing uses `adapter-types.ts`). **Bar 1:** GUI §5.6/§7.2; persisted provider command payload protocol, including Grok ACP and Codex item output. **Bars 4–5:** `commandDisplayDetail, commandOutputText, storedCommandOutput` is the shared stable seam; callers: UI entries.logic.ts/full-output.ts; daemon MCP transcript.ts/tools/output.ts. **Bars 2–3:** the per-case failure below is checked against explicit fixture results; storage identity uses round-trip preservation. **Bar 6:** these cases own the distinct data/lifecycle edges; no stronger retained owner tests those same edge conditions at a lower seam. Risk if coverage were removed: Output readers could hide actual stdout, report previews as full output, or drop provider whitespace.

| Original location and exact title | Disposition | Failure / rationale and remaining owner |
| --- | --- | --- |
| `packages/api/src/agent-chat/command-output.test.ts:16` — Codex: a command with no detail shows its item's aggregatedOutput, trimmed | **KEEP** | Codex output is absent when no provider detail is available. |
| `packages/api/src/agent-chat/command-output.test.ts:27` — a detail that repeats the row's title gives way to the output | **KEEP** | A title echo masks meaningful command output. |
| `packages/api/src/agent-chat/command-output.test.ts:38` — Grok: an executing call whose detail echoes the command shows rawOutput's stdout and stderr, joined | **KEEP** | ACP command echo masks stdout/stderr, including stderr-only output. |
| `packages/api/src/agent-chat/command-output.test.ts:52` — Grok: ACP content blocks are read when rawOutput says nothing, only their `content` blocks' text | **KEEP** | ACP content blocks disappear or diff blocks become textual output. |
| `packages/api/src/agent-chat/command-output.test.ts:70` — an echo with no output yet shows no detail at all: the row already shows the command | **KEEP** | An in-flight command redundantly displays its command as output. |
| `packages/api/src/agent-chat/command-output.test.ts:79` — an echo cut short with "..." or "…" is still an echo, and cannot mask the output | **KEEP** | A truncated command echo masks real output or unrelated text is misclassified. |
| `packages/api/src/agent-chat/command-output.test.ts:92` — an echo counts only on a call whose data says it executes (ACP's kind, any case) | **KEEP** | A non-executing provider call loses valid detail by false echo detection. |
| `packages/api/src/agent-chat/command-output.test.ts:100` — a provider detail that already says more stands (OpenCode's output, Codex's own detail) | **KEEP** | Existing fuller provider detail is overwritten by a poorer preview. |
| `packages/api/src/agent-chat/command-output.test.ts:106` — any other row shows its own detail, trimmed, whatever output its data carries | **KEEP** | Non-command rows invent output or malformed payloads crash the reader. |
| `packages/api/src/agent-chat/command-output.test.ts:115` — options.detail is the detail the caller kept: none reads as an empty one | **KEEP** | Promoted task detail is repeated instead of showing remaining output. |
| `packages/api/src/agent-chat/command-output.test.ts:123` — the output survives the wire projection every read path applies | **REWRITE** | Codex aggregated output can be lost when wire projection drops its nested item field. Keep the single Codex projection/readability assertion; remove the Grok stdout and ACP examples already owned by slim.test.ts plus direct output-reader cases. Final diff review found that the remaining projection tests did not independently exercise Codex aggregatedOutput, so deleting the whole case would lose real coverage. |
| `packages/api/src/agent-chat/command-output.test.ts:142` — commandOutputText: Codex's aggregatedOutput whole — every line and its whitespace — where the preview trims it | **KEEP** | The full Codex output loses leading/trailing whitespace or lines. |
| `packages/api/src/agent-chat/command-output.test.ts:148` — commandOutputText: rawOutput's stdout then its stderr, each starting a line of its own; a blank stream is no output | **KEEP** | Separate streams concatenate without line boundaries or blank streams suppress stderr. |
| `packages/api/src/agent-chat/command-output.test.ts:157` — commandOutputText: ACP content blocks' texts, each starting a line of its own — only `content` blocks, blank ones skipped | **KEEP** | ACP full output loses whitespace or includes non-content blocks. |
| `packages/api/src/agent-chat/command-output.test.ts:172` — commandOutputText reads the places in the preview's order: the same place wins, as the provider wrote it | **KEEP** | Competing provider output locations select the wrong source, including byte-array fallback. |
| `packages/api/src/agent-chat/command-output.test.ts:199` — commandOutputText: no output is undefined — no data, blanks, non-text values | **KEEP** | Blank/non-text provider data becomes fabricated full output. |
| `packages/api/src/agent-chat/command-output.test.ts:205` — storedCommandOutput: an item stored whole holds its output whole, whatever row of the call it is | **KEEP** | Untruncated stored rows are incorrectly treated as partial output. |
| `packages/api/src/agent-chat/command-output.test.ts:213` — storedCommandOutput: a completion stored cut holds its output's head — Codex past 64 KiB — never the whole | **KEEP** | A cut completion is incorrectly promised as the entire output. |
| `packages/api/src/agent-chat/command-output.test.ts:220` — storedCommandOutput: an update stored cut holds no part of the output — its data is the wire's one-line preview | **KEEP** | A persisted slimmed update is mislabeled as full command output. |
| `packages/api/src/agent-chat/command-output.test.ts:228` — storedCommandOutput: no command, or no output, is nothing | **KEEP** | Non-command/empty/malformed stored rows create a false output result. |

## `compaction.test.ts`

Owner: `compaction.ts` (contracts also use `wire.ts`/`runtime-events.ts`; goal capability parsing uses `adapter-types.ts`). **Bar 1:** GUI §5.5/§7.3 and legacy persisted compaction markers. **Bars 4–5:** `isSettledConversationCompaction and the shared compaction predicates` is the shared stable seam; callers: UI history/rewind gates; daemon MCP sessions.ts and thread index. **Bars 2–3:** the per-case failure below is checked against explicit fixture results; storage identity uses round-trip preservation. **Bar 6:** these cases own the distinct data/lifecycle edges; no stronger retained owner tests those same edge conditions at a lower seam. Risk if coverage were removed: An incorrect marker either permits impossible rewinds or prevents valid rewinds.

| Original location and exact title | Disposition | Failure / rationale and remaining owner |
| --- | --- | --- |
| `packages/api/src/agent-chat/compaction.test.ts:46` — a context-compaction row is settled unless it says it is running or failed | **KEEP** | Legacy state-less compactions disappear or failed/in-flight compactions close rewind history. |
| `packages/api/src/agent-chat/compaction.test.ts:59` — the legacy thread.state.changed marker counts only when it says compacted | **KEEP** | Legacy compacted markers disappear or unrelated legacy state becomes a rewind boundary. |
| `packages/api/src/agent-chat/compaction.test.ts:73` — a subagent's own compaction is not the conversation's: agentId on the row or on its payload | **KEEP** | A child agent compaction removes the parent conversation rewind history. |
| `packages/api/src/agent-chat/compaction.test.ts:85` — a blank or non-string agentId owns nothing — the UI's quiet-timeline rule | **KEEP** | Malformed/blank ownership hides the parent compaction boundary. |
| `packages/api/src/agent-chat/compaction.test.ts:97` — every phase of the conversation's own marker is a conversation compaction; only compacted is settled | **KEEP** | UI phase reporting differs from settled rewind eligibility. |
| `packages/api/src/agent-chat/compaction.test.ts:106` — a message is never a compaction marker, whatever it says or whoever owns it | **KEEP** | A user/assistant message is mistaken for a completed compaction. |
| `packages/api/src/agent-chat/compaction.test.ts:111` — an activity of any other kind is not one, even with a compacted state | **KEEP** | An unrelated activity carrying a state field becomes a compaction boundary. |

## `contracts.test.ts`

Owner: `contracts.ts` (contracts also use `wire.ts`/`runtime-events.ts`; goal capability parsing uses `adapter-types.ts`). **Bar 1:** GUI §6 REST paths, output-window wire interface, §4.2/§7.6 provider task classification. **Bars 4–5:** `agentChatRoutes, agentChatCommandPath, isThreadItemOutputWindow, classifyTaskAgentKind` is the shared stable seam; callers: Daemon route registration/ingestion, reference client, GUI and MCP clients. **Bars 2–3:** the per-case failure below is checked against explicit fixture results; storage identity uses round-trip preservation. **Bar 6:** these cases own the distinct data/lifecycle edges; no stronger retained owner tests those same edge conditions at a lower seam. Risk if coverage were removed: A broken URL, incompatible output response or task classification affects independent callers.

| Original location and exact title | Disposition | Failure / rationale and remaining owner |
| --- | --- | --- |
| `packages/api/src/agent-chat/contracts.test.ts:6` — route builders produce the §6 paths and encode their segments | **KEEP** | Session/item path segments cease to be URI encoded, or specified route suffixes change. |
| `packages/api/src/agent-chat/contracts.test.ts:20` — isThreadItemOutputWindow accepts one window of a join, and never the whole join a host that ignores the query answers | **KEEP** | Legacy whole joins or invalid offsets/types are accepted as output windows. |
| `packages/api/src/agent-chat/contracts.test.ts:49` — classifyTaskAgentKind is a denylist, and nesting flips it | **KEEP** | Drifted agent task names disappear or inert/nested tasks masquerade as active agents. |

## `failure-reason.test.ts`

Owner: `failure-reason.ts` (contracts also use `wire.ts`/`runtime-events.ts`; goal capability parsing uses `adapter-types.ts`). **Bar 1:** Workflow §5.4 account failover and legacy persisted Claude/Grok failure sentences. **Bars 4–5:** `failureReasonOfActivity, latestFailureReason` is the shared stable seam; callers: Daemon workflows/agent/classify.ts, watch.ts and executor.ts. **Bars 2–3:** the per-case failure below is checked against explicit fixture results; storage identity uses round-trip preservation. **Bar 6:** these cases own the distinct data/lifecycle edges; no stronger retained owner tests those same edge conditions at a lower seam. Risk if coverage were removed: Wrong account failover, reset deadline or baseline can retry a refused account or switch a healthy account.

| Original location and exact title | Disposition | Failure / rationale and remaining owner |
| --- | --- | --- |
| `packages/api/src/agent-chat/failure-reason.test.ts:31` — the structured reason and reset are read off the payload | **KEEP** | Structured auth/usage-limit state or its normalized reset instant is lost. |
| `packages/api/src/agent-chat/failure-reason.test.ts:51` — an unreadable reset is dropped, never guessed | **KEEP** | An unreadable reset time is invented instead of omitted. |
| `packages/api/src/agent-chat/failure-reason.test.ts:59` — only runtime.error and runtime.warning rows name a failure | **KEEP** | Ordinary tool/provider errors trigger account failover. |
| `packages/api/src/agent-chat/failure-reason.test.ts:70` — an unknown reason is no failure this reader knows — and never read by its text | **KEEP** | A new structured reason is overridden by an obsolete text prefix. |
| `packages/api/src/agent-chat/failure-reason.test.ts:79` — legacy: the adapters' real sentences | **KEEP** | Legacy persisted account failures stop being recognized. |
| `packages/api/src/agent-chat/failure-reason.test.ts:98` — legacy: a parked-turn warning's reset comes from its rate_limit_info detail | **REWRITE** | Legacy epoch-second reset is interpreted as milliseconds or marked nonlegacy. Use literal 2026-09-21T05:40:00.000Z from the epoch-seconds fixture, instead of repeating production seconds-to-Date conversion. |
| `packages/api/src/agent-chat/failure-reason.test.ts:109` — legacy: a prefix only counts at the start, and not when a reason is present | **KEEP** | A substring triggers false failover or text overrides authoritative structured reason. |
| `packages/api/src/agent-chat/failure-reason.test.ts:121` — the summary stands in for a payload with no message | **KEEP** | A valid failure loses its fallback message. |
| `packages/api/src/agent-chat/failure-reason.test.ts:128` — latestFailureReason: the newest failure, messages skipped | **KEEP** | An older failure or assistant text wins over the newest relevant failure. |
| `packages/api/src/agent-chat/failure-reason.test.ts:147` — latestFailureReason: a baseline by time or by item id | **KEEP** | A failure before a workflow baseline causes a new run to fail over. |

## `fold-snapshot.test.ts`

Owner: `fold-snapshot.ts` (contracts also use `wire.ts`/`runtime-events.ts`; goal capability parsing uses `adapter-types.ts`). **Bar 1:** Thread-index design A2 and AGENTS.md cache trust, append-only-log and tolerant-storage rules; goals §4.4/§5.5/§5.7. **Bars 4–5:** `serializeFoldState, deserializeFoldState, parseFoldSnapshotFile; applyDomainEvent after restore` is the shared stable seam; callers: Daemon agent-host/store/index.ts and orchestration/orchestrator.ts. **Bars 2–3:** the per-case failure below is checked against explicit fixture results; storage identity uses round-trip preservation. **Bar 6:** these cases own the distinct data/lifecycle edges; no stronger retained owner tests those same edge conditions at a lower seam. Risk if coverage were removed: A trusted bad cache loses history or resumes wrong state; a rejected valid cache forces unnecessary replay.

| Original location and exact title | Disposition | Failure / rationale and remaining owner |
| --- | --- | --- |
| `packages/api/src/agent-chat/fold-snapshot.test.ts:312` — deserialize(serialize(state)) is the state, Sets and Maps included | **REWRITE** | JSON storage loses fold fields, tombstone Sets or resolution Maps. Keep the JSON storage round trip and remove its redundant in-memory serialize/deserialize assertion; the JSON path exercises the stronger actual persistence boundary. |
| `packages/api/src/agent-chat/fold-snapshot.test.ts:318` — a streamed message after restore updates the message following a colliding activity id | **KEEP** | After restore a colliding activity/message ID updates the wrong row. |
| `packages/api/src/agent-chat/fold-snapshot.test.ts:332` — the empty state and a headless state round-trip | **KEEP** | A partial/headless log cannot be snapshotted/restored faithfully. |
| `packages/api/src/agent-chat/fold-snapshot.test.ts:345` — a state built before the tombstone stamps existed keeps closedRequestAt absent | **KEEP** | A legacy unstamped tombstone acquires invented ordering information. |
| `packages/api/src/agent-chat/fold-snapshot.test.ts:354` — a head carrying the §3.3 continuation marker round-trips | **KEEP** | Restart continuation identity is lost during storage. |
| `packages/api/src/agent-chat/fold-snapshot.test.ts:366` — a head carrying the goals §5.5 resume marker round-trips | **KEEP** | Goal resume intent is lost across restart, or absence is rejected. |
| `packages/api/src/agent-chat/fold-snapshot.test.ts:377` — a head carrying the goals §5.7 hold marker round-trips | **KEEP** | Goal handover hold/resume state is lost across restart. |
| `packages/api/src/agent-chat/fold-snapshot.test.ts:394` — a restored snapshot preserves closed requests, streamed text and activity updates through a trim | **KEEP** | Restore followed by trim loses resolved-request closure or mismerges rows/text. |
| `packages/api/src/agent-chat/fold-snapshot.test.ts:425` — anything that is not a serialized fold state deserializes to null | **KEEP** | Non-object cache data is trusted as a fold. |
| `packages/api/src/agent-chat/fold-snapshot.test.ts:431` — a missing top-level field is rejected; only closedRequestAt is optional | **KEEP** | Missing required fold fields are trusted instead of causing replay. |
| `packages/api/src/agent-chat/fold-snapshot.test.ts:444` — a field of the wrong shape anywhere in the state is rejected | **KEEP** | Malformed nested cache data or a head/sequence mismatch is trusted. |
| `packages/api/src/agent-chat/fold-snapshot.test.ts:490` — what the fold copies through untouched is not second-guessed | **KEEP** | Unknown additive/provider-opaque data is discarded or rejected. |
| `packages/api/src/agent-chat/fold-snapshot.test.ts:530` — a well-formed snapshot file parses, and its state restores the fold | **KEEP** | Snapshot file metadata/extras or validated state fails to survive its storage interface. |
| `packages/api/src/agent-chat/fold-snapshot.test.ts:544` — a snapshot file without extras parses without an extras key | **KEEP** | Absent optional extras becomes a fabricated persisted field. |
| `packages/api/src/agent-chat/fold-snapshot.test.ts:550` — a snapshot file of another version, another thread or a bad shape is rejected | **KEEP** | Wrong-version/thread/position or malformed snapshot files are trusted. |
| `packages/api/src/agent-chat/fold-snapshot.test.ts:582` — a snapshot of an empty, headless fold is a valid file | **KEEP** | A valid empty-log snapshot is rejected by the file wrapper. |
| `packages/api/src/agent-chat/fold-snapshot.test.ts:596` — goal: null is a thread with no goal — accepted, and written for every state that has none | **KEEP** | No-goal/legacy-goal state fails to serialize as explicit null. |
| `packages/api/src/agent-chat/fold-snapshot.test.ts:612` — a missing goal key rejects the snapshot: a cache miss | **DELETE** | Duplicate missing-goal rejection already owned by required-top-level-field validation. The required-field test already rejects a missing goal, and the snapshot-file rejection test verifies invalid nested state rejection. |
| `packages/api/src/agent-chat/fold-snapshot.test.ts:622` — a stored goal that is neither null nor a valid ThreadGoal rejects the snapshot: a cache miss | **REWRITE** | A stored goal impossible for the fold to produce is trusted instead of causing replay. Keep malformed persisted-goal cases at deserializeFoldState; remove repeating every case through the already-validated file wrapper. |

## `fold.goal.test.ts`

Owner: `fold.goal.ts` (contracts also use `wire.ts`/`runtime-events.ts`; goal capability parsing uses `adapter-types.ts`). **Bar 1:** Goals §4.4: latest valid provider goal, independent of conversation rewind and retention. **Bars 4–5:** `foldThread/applyDomainEvent and toThreadSnapshot` is the shared stable seam; callers: Daemon store/orchestrator and GUI reducer. **Bars 2–3:** the per-case failure below is checked against explicit fixture results; storage identity uses round-trip preservation. **Bar 6:** these cases own the distinct data/lifecycle edges; no stronger retained owner tests those same edge conditions at a lower seam. Risk if coverage were removed: Goal chip/host watchdog can lose, retain stale, or fabricate provider state.

| Original location and exact title | Disposition | Failure / rationale and remaining owner |
| --- | --- | --- |
| `packages/api/src/agent-chat/fold.goal.test.ts:74` — a fresh fold has no goal, and neither does a thread that never set one | **DELETE** | Duplicate no-goal initialization already checked by snapshot and null-goal contracts. The retained wire-snapshot null-goal test and fold-snapshot null/legacy test already exercise fresh no-goal state. |
| `packages/api/src/agent-chat/fold.goal.test.ts:82` — a goal.updated row sets the goal, stamped with the ROW's updatedAt, and is appended as usual | **KEEP** | Goal state uses ingestion time instead of the row timestamp, or drops its visible event. |
| `packages/api/src/agent-chat/fold.goal.test.ts:104` — the last row wins, a null goal clears it, and a cleared thread can set another | **KEEP** | A later goal update/clear/replacement leaves stale state. |
| `packages/api/src/agent-chat/fold.goal.test.ts:129` — a row that does not parse leaves the goal as it was — and is still appended | **KEEP** | A malformed goal update destroys the last known good provider goal. |
| `packages/api/src/agent-chat/fold.goal.test.ts:149` — only a goal.updated row moves the goal | **KEEP** | A command/status/session/message changes the goal without provider confirmation. |
| `packages/api/src/agent-chat/fold.goal.test.ts:172` — the fold keeps the PARSED goal: bad optional fields and unknown keys never reach it | **KEEP** | Invalid optional provider fields leak into the derived goal while raw history is lost. |
| `packages/api/src/agent-chat/fold.goal.test.ts:183` — a goal row replaced in place still decides the goal | **KEEP** | In-place goal progress updates leave the previous goal cached. |
| `packages/api/src/agent-chat/fold.goal.test.ts:195` — retention never drops the goal, even once its row has aged out of the window | **KEEP** | A busy conversation evicts the current provider goal with its event row. |
| `packages/api/src/agent-chat/fold.goal.test.ts:209` — a rewind never touches the goal, even when it removes the row that set it | **KEEP** | Conversation rewind restores/clears a provider goal it does not own. |
| `packages/api/src/agent-chat/fold.goal.test.ts:237` — toThreadSnapshot carries the goal, and null when there is none | **KEEP** | The wire snapshot omits the current goal or fails to spell no-goal as null. |
| `packages/api/src/agent-chat/fold.goal.test.ts:244` — a state built before goals existed still folds, and its missing goal reads as null | **KEEP** | A state constructed by an older host cannot fold or expose a later goal. |

## `fold.retention.test.ts`

Owner: `fold.retention.ts` (contracts also use `wire.ts`/`runtime-events.ts`; goal capability parsing uses `adapter-types.ts`). **Bar 1:** GUI §5.1/§5.5/§7.6; fold-performance design B; long-call start-loss regression and open-work retention contract. **Bars 4–5:** `foldThread/applyDomainEvent, itemsDroppedByRetention, serialized eviction metadata` is the shared stable seam; callers: Daemon store/history; GUI reducer and history.logic.ts bridge. **Bars 2–3:** the per-case failure below is checked against explicit fixture results; storage identity uses round-trip preservation. **Bar 6:** these cases own the distinct data/lifecycle edges; no stronger retained owner tests those same edge conditions at a lower seam. Risk if coverage were removed: History, running tools, questions or roster entries disappear; unbounded windows grow memory.

| Original location and exact title | Disposition | Failure / rationale and remaining owner |
| --- | --- | --- |
| `packages/api/src/agent-chat/fold.retention.test.ts:80` — the parent window grows to its limit plus slack, then one trim cuts it to the limit | **KEEP** | Parent rows are trimmed too early/late, in wrong order, or without eviction reporting. |
| `packages/api/src/agent-chat/fold.retention.test.ts:106` — an agent's own window trims past 200 + 50 of its rows, keeping its anchors | **KEEP** | One agent evicts parent history or loses its launch anchors at its own limit. |
| `packages/api/src/agent-chat/fold.retention.test.ts:144` — the gate: 400 activities of one agent fold losslessly — a history page never trims | **KEEP** | A <=400-activity history page loses rows merely because one agent owns them. |
| `packages/api/src/agent-chat/fold.retention.test.ts:170` — the ceiling across agents trims past 2 000 + 200 of their rows, oldest first, ties in list order | **KEEP** | Many small agent windows evade the total bound or lose newer rows before older ones. |
| `packages/api/src/agent-chat/fold.retention.test.ts:208` — messages trim past 2 000 + 200 without touching the activities, pending or roster | **KEEP** | Message retention deletes activities, pending approval or active roster state. |
| `packages/api/src/agent-chat/fold.retention.test.ts:233` — a trim cuts every class at once, whichever one tripped it | **KEEP** | A trim leaves another over-limit class unbounded. |
| `packages/api/src/agent-chat/fold.retention.test.ts:252` — more open questions than the slack keep the trigger on without dropping them — time, never correctness | **KEEP** | Many unresolved async questions vanish when retained exceptions exceed slack. |
| `packages/api/src/agent-chat/fold.retention.test.ts:290` — compaction markers are exempt in the parent window only | **KEEP** | An agent compaction is retained forever or the parent marker is removed. |
| `packages/api/src/agent-chat/fold.retention.test.ts:313` — the legacy compaction marker is kept whatever its age, as context-compaction is; any other thread.state.changed is an ordinary row | **KEEP** | Old-format compactions disappear, or unrelated thread states become immortal. |
| `packages/api/src/agent-chat/fold.retention.test.ts:413` — a running parent call keeps its opening row through 1 200 of its own chunks, and the window stays bounded | **KEEP** | A long parent command loses its title/start while still streaming. |
| `packages/api/src/agent-chat/fold.retention.test.ts:428` — a running agent-owned call keeps its opening row through 1 200 of its own chunks in a busy thread | **KEEP** | A long child command loses its start within its own bounded window. |
| `packages/api/src/agent-chat/fold.retention.test.ts:447` — a running agent-owned call keeps its opening row under the ceiling across agents, where its older chunk goes | **KEEP** | The across-agent ceiling removes a running command start. |
| `packages/api/src/agent-chat/fold.retention.test.ts:470` — once a ${closer} closes the call, the next trim drops its opening row, and no trim before it did | **KEEP** | Completion/denial fails to release the retained opening at the next trim (two closer cases). |
| `packages/api/src/agent-chat/fold.retention.test.ts:487` — the ${window} window keeps the openings of the 16 most recently active open calls behind its cut: a streaming call outranks 40 opened after it and left quiet, and every trim frees its slack minus 16 | **KEEP** | Quiet stale calls crowd a printing call out of the bounded retained-opening slots (parent/agent cases). |
| `packages/api/src/agent-chat/fold.retention.test.ts:540` — a burst of calls in flight inside the window takes no slot from an old quiet shell's start: a window's cap ranks only the openings its cut would drop | **KEEP** | Recent calls already inside the normal window evict an old running shell start. |
| `packages/api/src/agent-chat/fold.retention.test.ts:568` — the ceiling's slots go to openings that survived their own window: those an agent's own cap dropped take none | **KEEP** | Openings already removed by one agent consume the global survivors budget. |
| `packages/api/src/agent-chat/fold.retention.test.ts:609` — a running background shell keeps its task.started through 600 parent rows, so the roster keeps it; once it ends, a trim drops it | **KEEP** | A live background shell disappears from the roster before its completion. |
| `packages/api/src/agent-chat/fold.retention.test.ts:654` — evicted: absent until a trim drops something, then only ever grows, and survives a rewind | **KEEP** | Eviction metadata resets during later folds/rewind/JSON restore, hiding older history. |
| `packages/api/src/agent-chat/fold.retention.test.ts:703` — itemsDroppedByRetention: exactly the rows the step's trim removed, in list order, and stable | **KEEP** | The GUI history bridge receives missing, duplicated or out-of-order dropped rows. |

## `fold.test.ts`

Owner: `fold.ts` (contracts also use `wire.ts`/`runtime-events.ts`; goal capability parsing uses `adapter-types.ts`). **Bar 1:** GUI §5.1 event projection, §5.4 checkpoints, §5.5 rewind, §6.3 snapshot, §6.6 replay; AGENTS.md resume identity and sequence rules. **Bars 4–5:** `foldThread/applyDomainEvent/toThreadSnapshot` is the shared stable seam; callers: Daemon store/orchestrator; GUI reducer. **Bars 2–3:** the per-case failure below is checked against explicit fixture results; storage identity uses round-trip preservation. **Bar 6:** these cases own the distinct data/lifecycle edges; no stronger retained owner tests those same edge conditions at a lower seam. Risk if coverage were removed: Events can corrupt visible messages, turn state, rewinds, approvals or provider resume identity.

| Original location and exact title | Disposition | Failure / rationale and remaining owner |
| --- | --- | --- |
| `packages/api/src/agent-chat/fold.test.ts:51` — an empty fold has no head and is snapshot-refusing | **KEEP** | A headless log is served as a valid thread snapshot. |
| `packages/api/src/agent-chat/fold.test.ts:57` — thread.created builds the head; meta and mode updates patch it | **KEEP** | Thread metadata/mode patches fail to reach caller-visible head state. |
| `packages/api/src/agent-chat/fold.test.ts:73` — an event with seq <= the state's is dropped (overlapping replay windows) | **KEEP** | Overlapping event replay renames a thread with stale data. |
| `packages/api/src/agent-chat/fold.test.ts:84` — an event for another thread is not this fold's | **KEEP** | An event belonging to another thread mutates this thread. |
| `packages/api/src/agent-chat/fold.test.ts:96` — thread.deleted marks the fold deleted | **KEEP** | The durable delete event never marks its thread deleted. |
| `packages/api/src/agent-chat/fold.test.ts:104` — streaming deltas append; a non-empty completion replaces; an empty one keeps | **KEEP** | Stream chunks are replaced/lost or final replacement/empty completion corrupts text. |
| `packages/api/src/agent-chat/fold.test.ts:148` — reasoning is a sibling message with its own role and id namespace | **KEEP** | Reasoning overwrites the answer instead of preserving its own role/identity. |
| `packages/api/src/agent-chat/fold.test.ts:172` — the turn settles from session status, not from a checkpoint | **KEEP** | A late checkpoint extends a settled turn duration. |
| `packages/api/src/agent-chat/fold.test.ts:202` — an interrupt settles the turn interrupted and keeps its completedAt | **REWRITE** | Interrupt fails to settle the turn or record its end. Drop a redundant assertion through the unused deriveLatestTurn wrapper; preserve interrupted state/end assertion. |
| `packages/api/src/agent-chat/fold.test.ts:216` — an error session fails the turn | **KEEP** | A provider error leaves a turn running or loses its error state. |
| `packages/api/src/agent-chat/fold.test.ts:228` — a provider-initiated turn the host never commanded is still recorded | **KEEP** | Provider-initiated continuation turns are absent from history. |
| `packages/api/src/agent-chat/fold.test.ts:239` — the first assistant message of a turn becomes its anchor | **KEEP** | A later assistant segment replaces the first answer anchor. |
| `packages/api/src/agent-chat/fold.test.ts:263` — a turn records the prompt that opened it, through adoption, settlement and capture | **KEEP** | The opening prompt is lost through pending-turn adoption/settlement/checkpointing. |
| `packages/api/src/agent-chat/fold.test.ts:296` — a turn with no nameable prompt records none | **KEEP** | A transcript/continuation turn gains a fabricated prompt link. |
| `packages/api/src/agent-chat/fold.test.ts:338` — a missing placeholder never clobbers a captured ready checkpoint | **KEEP** | A missing placeholder erases a captured checkpoint. |
| `packages/api/src/agent-chat/fold.test.ts:345` — checkpoints stay sorted by turn count and the head mirrors the highest | **KEEP** | Out-of-order captures move head turn count backwards or scramble checkpoint order. |
| `packages/api/src/agent-chat/fold.test.ts:354` — an activity with a known id is replaced in place, not appended | **KEEP** | An in-place activity update duplicates rather than replaces its row. |
| `packages/api/src/agent-chat/fold.test.ts:368` — pending is re-derived from the activity fold and tombstoned by a resolution | **DELETE** | Duplicate basic pending integration, superseded by retention/tombstone fold regressions and pending owner tests. pending.test.ts owns basic resolution; retained aged-out/recycled/retention fold regressions verify the integration and closure. |
| `packages/api/src/agent-chat/fold.test.ts:390` — a tombstoned request stays closed after its resolution ages out of retention | **KEEP** | An aged-out approval resolution permits a replayed dead request to reopen. |
| `packages/api/src/agent-chat/fold.test.ts:430` — an aged-out user-input resolution keeps its question closed too | **KEEP** | An aged-out question resolution permits the dismissed question to reopen. |
| `packages/api/src/agent-chat/fold.test.ts:462` — a RECYCLED request id opens a fresh card even across retention (R2-1) | **KEEP** | A new approval reusing an old request ID vanishes after retention. |
| `packages/api/src/agent-chat/fold.test.ts:508` — retention that drops a request row re-derives pending on that very event | **KEEP** | Unrelated retention leaves pending referencing a removed activity. |
| `packages/api/src/agent-chat/fold.test.ts:552` — the roster re-derives on task rows and interrupts live rows when the session dies | **KEEP** | Session death fails to invalidate the fold roster despite unchanged task events. |
| `packages/api/src/agent-chat/fold.test.ts:569` — activities are retained at the window, keeping an unresolved async question | **DELETE** | Duplicate async-question retention, superseded by the multiple-open-question retention stress case. fold.retention.test.ts multiple-open-question case proves the same exemption beyond slack, with pending state and actual dropped rows. |
| `packages/api/src/agent-chat/fold.test.ts:608` — a compaction marker never ages out of the window | **KEEP** | A parent compaction boundary vanishes once parent history is trimmed. |
| `packages/api/src/agent-chat/fold.test.ts:750` — a revert truncates by retained turn id and recomputes the latest turn | **REWRITE** | A rewind leaves removed turn rows/messages/checkpoints or stale latest state. Read the last public turn row directly so the contract no longer depends on a dead projection helper. |
| `packages/api/src/agent-chat/fold.test.ts:766` — turn-less rows survive a revert | **KEEP** | A rewind removes ambient turnless activities or keeps discarded turn prompts. |
| `packages/api/src/agent-chat/fold.test.ts:791` — the fallback pass is bounded at `target` per role | **KEEP** | Unlinked legacy prompts restore beyond the kept turn count. |
| `packages/api/src/agent-chat/fold.test.ts:808` — a message whose turn was truncated is never restored by the fallback | **KEEP** | Fallback restores a message from a removed turn. |
| `packages/api/src/agent-chat/fold.test.ts:838` — a revert re-derives pending and roster from the surviving activities | **KEEP** | Rewind leaves the discarded turn agent on the roster. |
| `packages/api/src/agent-chat/fold.test.ts:854` — a revert on a thread with no checkpoints keeps exactly the first `target` turns | **REWRITE** | A non-git thread with no checkpoints cannot rewind by started-turn order. Remove redundant latest-turn helper assertion; exact surviving turns already prove the rewind result. |
| `packages/api/src/agent-chat/fold.test.ts:874` — densely numbered checkpoints go with their turns, not with their counts | **KEEP** | Densely numbered legacy captures keep the wrong conversation turns. |
| `packages/api/src/agent-chat/fold.test.ts:895` — a sparse checkpoint list never reorders the retained turns | **REWRITE** | Sparse captures reorder turns and corrupt later rewind ordinals. Remove redundant latest-turn helper assertion; ordered turn tuples already prove the latest turn. |
| `packages/api/src/agent-chat/fold.test.ts:918` — a revert to zero turns keeps only the thread's turn-less rows | **KEEP** | Rewind to zero leaves conversation content or removes ambient activities. |
| `packages/api/src/agent-chat/fold.test.ts:934` — a steer follows the turn it was steered into | **KEEP** | A steered prompt is detached from the turn it modifies. |
| `packages/api/src/agent-chat/fold.test.ts:949` — a retained turn whose prompt no turn row names still keeps it (a /compact turn) | **KEEP** | A compact command prompt disappears when its synthesized turn survives. |
| `packages/api/src/agent-chat/fold.test.ts:974` — a prompt a dropped turn claims is never resurrected by the fallback | **KEEP** | A removed turn prompt reappears to fill a legacy fallback deficit. |
| `packages/api/src/agent-chat/fold.test.ts:1006` — the legacy fallback: with no started turn, a revert still truncates by checkpoint count | **KEEP** | Old logs without turn rows no longer rewind through checkpoint identity. |
| `packages/api/src/agent-chat/fold.test.ts:1048` — toThreadSnapshot projects the §6.3 read shape | **KEEP** | The read snapshot omits projected messages/checkpoints/pending metadata. |
| `packages/api/src/agent-chat/fold.test.ts:1061` — toThreadSnapshot carries each turn's prompt through, before and after a revert | **KEEP** | Wire snapshot turns lose their prompt claims before/after rewind. |
| `packages/api/src/agent-chat/fold.test.ts:1075` — fold — the resume cursor outlives a session block that omits it (kept across a settle, replaced only explicitly) | **REWRITE** | An omitted resume cursor/provider ID erases identity and starts a fresh conversation after restart. Use valid typed event builders and retain only omitted-cursor preservation plus explicit replacement; remove malformed head-shaped created fixture and unsafe casts. |

## `goal.test.ts`

Owner: `goal.ts` (contracts also use `wire.ts`/`runtime-events.ts`; goal capability parsing uses `adapter-types.ts`). **Bar 1:** Goals §4.1/§4.3/§4.5/§5.1, including the explicitly specified summary wording table. **Bars 4–5:** `Goal parsers, goalActivitySummary, goal predicates, parseGoalSupport` is the shared stable seam; callers: Provider adapters/ingestion; fold/snapshot; GUI capability/goal state; MCP catalogue/messages. **Bars 2–3:** the per-case failure below is checked against explicit fixture results; storage identity uses round-trip preservation. **Bar 6:** these cases own the distinct data/lifecycle edges; no stronger retained owner tests those same edge conditions at a lower seam. Risk if coverage were removed: Malformed provider state reaches callers or valid goal capabilities/state disappear; explicitly specified labels or command dispatch drift.

| Original location and exact title | Disposition | Failure / rationale and remaining owner |
| --- | --- | --- |
| `packages/api/src/agent-chat/goal.test.ts:44` — parseAgentGoal keeps a full goal field for field | **KEEP** | A valid full normalized goal loses optional provider metadata. |
| `packages/api/src/agent-chat/goal.test.ts:48` — an objective and a status are all a goal needs | **KEEP** | A valid minimal/status-varied goal is rejected. |
| `packages/api/src/agent-chat/goal.test.ts:58` — a goal without a usable objective or status is no goal | **KEEP** | An unusable objective or unknown/native status reaches typed goal state. |
| `packages/api/src/agent-chat/goal.test.ts:75` — anything that is not a record is no goal, and nothing makes the parser throw | **KEEP** | Malformed provider values throw or masquerade as goals. |
| `packages/api/src/agent-chat/goal.test.ts:83` — an optional field of the wrong type or range is dropped, and the goal kept | **KEEP** | Bad optional fields reject the whole goal or survive into typed state. |
| `packages/api/src/agent-chat/goal.test.ts:107` — a null token budget is kept — the goal has none — and zero is a count, not a gap | **KEEP** | A no-budget null or legitimate zero counter is lost. |
| `packages/api/src/agent-chat/goal.test.ts:126` — unknown keys are dropped, a thread goal's updatedAt included | **KEEP** | Unrecognized provider keys leak across the normalized API boundary. |
| `packages/api/src/agent-chat/goal.test.ts:134` — a payload with a goal, a change and the previous goal parses | **KEEP** | A replacement update drops its previous goal/change metadata. |
| `packages/api/src/agent-chat/goal.test.ts:143` — a null goal is the thread having none any more | **KEEP** | A cleared goal is rejected or resurrected. |
| `packages/api/src/agent-chat/goal.test.ts:156` — a goal that does not parse, or no goal field at all, is no payload | **KEEP** | Missing/invalid goal becomes an authoritative clear/update. |
| `packages/api/src/agent-chat/goal.test.ts:163` — an unknown or missing change is no payload | **KEEP** | Unknown changes pass or valid protocol changes are refused. |
| `packages/api/src/agent-chat/goal.test.ts:176` — a previous goal that does not parse is dropped, and the payload kept | **KEEP** | An invalid previous goal invalidates the current update. |
| `packages/api/src/agent-chat/goal.test.ts:186` — unknown keys are dropped at every level of the payload | **KEEP** | Unknown nested payload keys leak into normalized update state. |
| `packages/api/src/agent-chat/goal.test.ts:198` — anything that is not a record is no payload | **KEEP** | Non-record provider update values crash or become goal updates. |
| `packages/api/src/agent-chat/goal.test.ts:206` — the row text follows §4.3's table | **KEEP** | Persisted row summaries violate the independently specified wording table. |
| `packages/api/src/agent-chat/goal.test.ts:254` — a limit the goal does not name reads as the token budget | **KEEP** | A budget-exceeded event arriving before status labels the wrong limit. |
| `packages/api/src/agent-chat/goal.test.ts:262` — an objective is cut to 200 characters with an ellipsis; the payload keeps it whole | **KEEP** | Long goal objectives lose their full payload or exceed specified summary bound. |
| `packages/api/src/agent-chat/goal.test.ts:277` — the cut never splits a surrogate pair, and drops the whitespace before the ellipsis | **KEEP** | Goal labels contain a broken Unicode surrogate or malformed ellipsis boundary. |
| `packages/api/src/agent-chat/goal.test.ts:290` — a long last check is cut the same way | **KEEP** | A long check reason escapes the summary bound. |
| `packages/api/src/agent-chat/goal.test.ts:300` — only a progress row is hidden | **KEEP** | Visible goal lifecycle updates are hidden or progress floods the timeline. |
| `packages/api/src/agent-chat/goal.test.ts:307` — a goal is unfinished until it is complete or failed | **KEEP** | Paused/blocked/limited goals are incorrectly considered finished. |
| `packages/api/src/agent-chat/goal.test.ts:318` — sameGoalState compares objective, status, rounds, phase and last check — nothing else | **KEEP** | Counter-only provider updates flood history or real objective/state changes are suppressed. |
| `packages/api/src/agent-chat/goal.test.ts:346` — sameGoalState reads no goal as no goal, whichever way it is spelled | **KEEP** | No-goal spelling differences create false state changes. |
| `packages/api/src/agent-chat/goal.test.ts:355` — a thread goal is a goal plus the string updatedAt of the row that produced it | **KEEP** | Valid persisted thread-goal timestamps are lost. |
| `packages/api/src/agent-chat/goal.test.ts:365` — a thread goal without a string updatedAt, or whose goal does not parse, is none | **KEEP** | An invalid/missing persisted timestamp is trusted as a thread goal. |
| `packages/api/src/agent-chat/goal.test.ts:378` — isGoalCommandText is `/goal` then whitespace or nothing, in any case, after trimming | **KEEP** | Ordinary /goals or /goalie text is dispatched as a goal command, or valid whitespace/case is missed. |
| `packages/api/src/agent-chat/goal.test.ts:387` — parseGoalSupport keeps a well-formed block and only the actions this build knows | **KEEP** | Known goal actions/capabilities disappear when newer fields/actions arrive. |
| `packages/api/src/agent-chat/goal.test.ts:399` — parseGoalSupport reads a block that does not parse as none | **KEEP** | Malformed goal capability blocks reach typed consumer state. |

## `history-cursor.test.ts`

Owner: `history-cursor.ts` (contracts also use `wire.ts`/`runtime-events.ts`; goal capability parsing uses `adapter-types.ts`). **Bar 1:** Thread-index design History page: RFC 4648 URL-safe UTF-8 JSON cursor, thread binding and sequence bound. **Bars 4–5:** `encodeHistoryCursor/decodeHistoryCursor` is the shared stable seam; callers: Daemon orchestration readHistory and MCP history.ts. **Bars 2–3:** the per-case failure below is checked against explicit fixture results; storage identity uses round-trip preservation. **Bar 6:** these cases own the distinct data/lifecycle edges; no stronger retained owner tests those same edge conditions at a lower seam. Risk if coverage were removed: Paging duplicates/skips history, accepts another thread cursor or throws on malformed query input.

| Original location and exact title | Disposition | Failure / rationale and remaining owner |
| --- | --- | --- |
| `packages/api/src/agent-chat/history-cursor.test.ts:24` — the encoding is base64url of JSON {t, a, i}, unpadded | **KEEP** | Cursor bytes no longer match the interoperable URL-safe JSON wire format. |
| `packages/api/src/agent-chat/history-cursor.test.ts:34` — non-ASCII ids survive the round trip (UTF-8, not Latin-1) | **KEEP** | Unicode cursor IDs corrupt on encode/decode. |
| `packages/api/src/agent-chat/history-cursor.test.ts:45` — a cursor minted for another thread decodes to null | **KEEP** | A cursor for another thread is trusted for this thread. |
| `packages/api/src/agent-chat/history-cursor.test.ts:49` — anything malformed decodes to null and never throws | **KEEP** | Malformed query values throw or become usable history positions. |
| `packages/api/src/agent-chat/history-cursor.test.ts:86` — standard base64 (with + / and padding) is not base64url | **KEEP** | Standard base64 punctuation/padding is accepted as the URL-safe protocol. |
| `packages/api/src/agent-chat/history-cursor.test.ts:95` — fields beyond {t, a, i} are ignored, so a later field cannot break an old host | **KEEP** | A newer additive cursor field breaks older hosts. |
| `packages/api/src/agent-chat/history-cursor.test.ts:102` — a cursor may carry a sequence bound inside its turn, and a bad one is rejected | **KEEP** | Inside-turn pagination loses its positive sequence bound or accepts invalid bounds. |

## `identity.test.ts`

Owner: `identity.ts` (contracts also use `wire.ts`/`runtime-events.ts`; goal capability parsing uses `adapter-types.ts`). **Bar 1:** GUI §3.4/§6.1/§6.2 account-switch route and field-wise thread metadata contract. **Bars 4–5:** `agentChatRoutes.account and foldThread` is the shared stable seam; callers: Daemon account route/orchestrator and GUI thread updates. **Bars 2–3:** the per-case failure below is checked against explicit fixture results; storage identity uses round-trip preservation. **Bar 6:** these cases own the distinct data/lifecycle edges; no stronger retained owner tests those same edge conditions at a lower seam. Risk if coverage were removed: Account-switch requests fail or unrelated metadata changes reset the active account.

| Original location and exact title | Disposition | Failure / rationale and remaining owner |
| --- | --- | --- |
| `packages/api/src/agent-chat/identity.test.ts:23` — the account route is daemon-owned: a path, never a proxied command name | **KEEP** | Account switch URL does not encode a session ID as one path segment. |
| `packages/api/src/agent-chat/identity.test.ts:28` — thread.meta-updated carries the new identity onto the head | **KEEP** | The account/home change does not reach the thread head. |
| `packages/api/src/agent-chat/identity.test.ts:38` — a meta update that names neither identity field leaves the head's identity alone | **KEEP** | A rename silently clears active account identity. |
| `packages/api/src/agent-chat/identity.test.ts:49` — switching to the system identity clears the account id through the same event | **KEEP** | Switching to system leaves the old managed account ID. |

## `message-liveness.test.ts`

Owner: `message-liveness.ts` (contracts also use `wire.ts`/`runtime-events.ts`; goal capability parsing uses `adapter-types.ts`). **Bar 1:** GUI §5.1/§7.3; credible legacy log regression: settled agents/turns retain streaming:true indefinitely. **Bars 4–5:** `messageStreamingContext/isMessageStreaming` is the shared stable seam; callers: GUI store/hooks, timeline/history/drill-in readers. **Bars 2–3:** the per-case failure below is checked against explicit fixture results; storage identity uses round-trip preservation. **Bar 6:** these cases own the distinct data/lifecycle edges; no stronger retained owner tests those same edge conditions at a lower seam. Risk if coverage were removed: Dead streams leave Thinking indicators and prevent turn folding; live streams disappear.

| Original location and exact title | Disposition | Failure / rationale and remaining owner |
| --- | --- | --- |
| `packages/api/src/agent-chat/message-liveness.test.ts:81` — a turnless agent message reads settled once its agent completed, streaming while it runs | **KEEP** | Turnless completed-agent messages keep streaming, or live-agent messages falsely settle. |
| `packages/api/src/agent-chat/message-liveness.test.ts:88` — a parent message of a completed turn reads settled, of the running turn streaming | **KEEP** | Old parent answers keep streaming after their turn, or explicitly settled answers resume. |
| `packages/api/src/agent-chat/message-liveness.test.ts:96` — nothing reads streaming while the session is not live | **KEEP** | A stopped/headless/no-thread session continues presenting live message streams. |
| `packages/api/src/agent-chat/message-liveness.test.ts:120` — an agent is active while pending, running or waiting — never idle or settled | **KEEP** | Idle/settled/unknown agents or unowned turnless messages falsely stream. |

## `open-work.test.ts`

Owner: `open-work.ts` (contracts also use `wire.ts`/`runtime-events.ts`; goal capability parsing uses `adapter-types.ts`). **Bar 1:** Running-tool lifecycle and retained-opening contract; persisted tool/task rows may be malformed or out of order. **Bars 4–5:** `openWorkOf` is the shared stable seam; callers: Fold retention, daemon MCP history and orchestration/leftover-work.ts. **Bars 2–3:** the per-case failure below is checked against explicit fixture results; storage identity uses round-trip preservation. **Bar 6:** these cases own the distinct data/lifecycle edges; no stronger retained owner tests those same edge conditions at a lower seam. Risk if coverage were removed: Dead calls reopen or malformed rows create phantom running work.

| Original location and exact title | Disposition | Failure / rationale and remaining owner |
| --- | --- | --- |
| `packages/api/src/agent-chat/open-work.test.ts:34` — a closer closes a call for good: a completion or a denial, wherever it sits, and a call that only printed never opened | **KEEP** | An out-of-order completion/denial reopens a tool or chunks alone fabricate an opening. |
| `packages/api/src/agent-chat/open-work.test.ts:54` — blank ids are ignored, and so is a row whose payload is not a record | **KEEP** | Malformed activity IDs/payloads create phantom calls/tasks or crash the open-work reader. |

## `pending.test.ts`

Owner: `pending.ts` (contracts also use `wire.ts`/`runtime-events.ts`; goal capability parsing uses `adapter-types.ts`). **Bar 1:** GUI §5.1/§6.2/§7.5 provider approval/question protocol; R5 #4 tombstone and R2-1 recycled-ID regressions. **Bars 4–5:** `derivePendingRequests` is the shared stable seam; callers: Shared fold; host command gates and GUI approval/question cards. **Bars 2–3:** the per-case failure below is checked against explicit fixture results; storage identity uses round-trip preservation. **Bar 6:** these cases own the distinct data/lifecycle edges; no stronger retained owner tests those same edge conditions at a lower seam. Risk if coverage were removed: Real approvals/questions disappear, resolved requests reopen, or native answer keys change.

| Original location and exact title | Disposition | Failure / rationale and remaining owner |
| --- | --- | --- |
| `packages/api/src/agent-chat/pending.test.ts:12` — requestKindFromRequestType maps every native spelling | **REWRITE** | Legacy native approval type spellings are routed to the wrong canonical approval kind. Exercise native spellings through derivePendingRequests; make requestKindFromRequestType private. |
| `packages/api/src/agent-chat/pending.test.ts:24` — tracks open approvals and removes resolved ones | **KEEP** | Resolved approvals remain visible or independent open approvals vanish. |
| `packages/api/src/agent-chat/pending.test.ts:37` — a REPLAY of a resolved request cannot reopen it | **REWRITE** | Out-of-order replay resurrects an already resolved approval. Remove the seeded tombstone from this case: it previously let the test pass even if the explicit resolution row was ignored. The separate seeded-tombstone cases own that fallback. |
| `packages/api/src/agent-chat/pending.test.ts:61` — a dismissal's user-input.resolved row closes the question it answered | **KEEP** | Dismissal leaves an async question open, including redelivery of its original row. |
| `packages/api/src/agent-chat/pending.test.ts:85` — tool_user_input and auth_tokens_refresh never become approvals | **KEEP** | Token refresh/user-input callbacks become false permission prompts. |
| `packages/api/src/agent-chat/pending.test.ts:94` — an unrecognised request type still yields an actionable command approval | **KEEP** | A newer unknown approval type strands the provider without an actionable card. |
| `packages/api/src/agent-chat/pending.test.ts:102` — a canonical requestKind on the row wins over the raw requestType | **KEEP** | Raw provider type overrides authoritative canonical request kind. |
| `packages/api/src/agent-chat/pending.test.ts:114` — keeps detail, appName and well-formed options; drops malformed options | **KEEP** | Malformed options become selectable or valid approval metadata disappears. |
| `packages/api/src/agent-chat/pending.test.ts:139` — a stale-failure row closes the request; any other failure leaves it open | **KEEP** | A retryable response failure drops a card or a stale response leaves it actionable. |
| `packages/api/src/agent-chat/pending.test.ts:161` — a stale user-input failure closes the question | **KEEP** | A stale question response leaves an unusable question open. |
| `packages/api/src/agent-chat/pending.test.ts:176` — only async questions are dismissible | **KEEP** | Native callback questions acquire an unsupported Dismiss action. |
| `packages/api/src/agent-chat/pending.test.ts:198` — `responseMode` is promoted onto the pending entry, with the turn that asked | **KEEP** | Response mode/turn ownership fails to reach the shared pending contract. |
| `packages/api/src/agent-chat/pending.test.ts:233` — an unrecognised `responseMode` is not a message-mode question | **KEEP** | An unknown response mode gains message-mode privileges. |
| `packages/api/src/agent-chat/pending.test.ts:246` — parseQuestions preserves native answer keys and drops unanswerable cards | **REWRITE** | Native answer keys are trimmed or unusable options survive as answerable cards. Exercise native answer-key/option parsing through derivePendingRequests; make parseQuestions private. |
| `packages/api/src/agent-chat/pending.test.ts:269` — a question row with no decodable question at all is dropped, not shown empty | **KEEP** | A wholly unusable question produces an empty pending card. |
| `packages/api/src/agent-chat/pending.test.ts:280` — rows are ordered by createdAt | **KEEP** | Out-of-order request arrival scrambles chronological pending order. |
| `packages/api/src/agent-chat/pending.test.ts:293` — rows with no requestId, and non-request kinds, are ignored | **KEEP** | Malformed/unrelated rows produce phantom actionable requests. |
| `packages/api/src/agent-chat/pending.test.ts:305` — a request that arrives AFTER a resolution with the same id opens fresh | **KEEP** | A new approval recycling a resolved ID disappears. |
| `packages/api/src/agent-chat/pending.test.ts:334` — a recycled question id opens fresh too | **KEEP** | A new question recycling a resolved ID disappears. |
| `packages/api/src/agent-chat/pending.test.ts:350` — a seeded tombstone closes only requests at or before its stamp | **KEEP** | A timestamped tombstone swallows newer requests or reopens older ones. |
| `packages/api/src/agent-chat/pending.test.ts:386` — a seed with no stamps stays conservative | **KEEP** | A legacy unstamped tombstone resurrects a dead approval. |

## `plan.test.ts`

Owner: `plan.ts` (contracts also use `wire.ts`/`runtime-events.ts`; goal capability parsing uses `adapter-types.ts`). **Bar 1:** GUI §7.3 explicitly specifies PLEASE IMPLEMENT THIS PLAN followed by newline and trimmed plan. **Bars 4–5:** `buildPlanImplementationPrompt/isPlanImplementationMessage` is the shared stable seam; callers: GUI composer; daemon orchestrator, workflows and MCP messages/transcript. **Bars 2–3:** the per-case failure below is checked against explicit fixture results; storage identity uses round-trip preservation. **Bar 6:** these cases own the distinct data/lifecycle edges; no stronger retained owner tests those same edge conditions at a lower seam. Risk if coverage were removed: Implement sends a malformed command or leaves its proposal actionable after use.

| Original location and exact title | Disposition | Failure / rationale and remaining owner |
| --- | --- | --- |
| `packages/api/src/agent-chat/plan.test.ts:5` — the implementation prompt is the prefix plus the trimmed plan | **KEEP** | Implement input loses its required marker/newline or retains surrounding plan whitespace. |
| `packages/api/src/agent-chat/plan.test.ts:9` — isPlanImplementationMessage matches only the prefixed message | **KEEP** | Plan implementation is not recognized or ordinary text incorrectly retires a proposal. |

## `prompts.test.ts`

Owner: `prompts.ts` (contracts also use `wire.ts`/`runtime-events.ts`; goal capability parsing uses `adapter-types.ts`). **Bar 1:** Prompt-history reuse contract and provider transcript user-row protocol; image placeholders cannot be reused as attachments. **Bars 4–5:** `recallablePromptText` is the shared stable seam; callers: Daemon index queries/orchestrator; UI prompt-history/prompts.logic.ts. **Bars 2–3:** the per-case failure below is checked against explicit fixture results; storage identity uses round-trip preservation. **Bar 6:** these cases own the distinct data/lifecycle edges; no stronger retained owner tests those same edge conditions at a lower seam. Risk if coverage were removed: History offers provider-generated rows, loses real commands or reuses phantom image references.

| Original location and exact title | Disposition | Failure / rationale and remaining owner |
| --- | --- | --- |
| `packages/api/src/agent-chat/prompts.test.ts:7` — keeps what the user typed, trimmed | **KEEP** | Prompt reuse changes/removes the user text beyond edge whitespace. |
| `packages/api/src/agent-chat/prompts.test.ts:11` — drops the rows a provider's transcript wrote itself | **KEEP** | Provider internal transcript notices are offered as reusable user prompts. |
| `packages/api/src/agent-chat/prompts.test.ts:23` — drops the verbatim /compact and the plan's Implement prompt | **KEEP** | App-generated compact/implement commands pollute prompt history. |
| `packages/api/src/agent-chat/prompts.test.ts:28` — removes image placeholders with the space before them | **KEEP** | Image references without attachments remain in reused text. |
| `packages/api/src/agent-chat/prompts.test.ts:33` — drops a message that was only images or whitespace | **KEEP** | Image-only/blank messages become empty reusable prompts. |
| `packages/api/src/agent-chat/prompts.test.ts:38` — keeps a slash command the user typed | **KEEP** | A legitimate slash command disappears from reusable history. |

## `re-emitted.test.ts`

Owner: `re-emitted.ts` (contracts also use `wire.ts`/`runtime-events.ts`; goal capability parsing uses `adapter-types.ts`). **Bar 1:** Credible legacy Claude opening-message duplication regression, identified in recorded thread sequences 38664/38963; GUI §7.3. **Bars 4–5:** `reEmittedAssistantCopies` is the shared stable seam; callers: GUI entries.logic.ts; daemon MCP views/transcript and workflow executor. **Bars 2–3:** the per-case failure below is checked against explicit fixture results; storage identity uses round-trip preservation. **Bar 6:** these cases own the distinct data/lifecycle edges; no stronger retained owner tests those same edge conditions at a lower seam. Risk if coverage were removed: A duplicate becomes the displayed final answer, or legitimate repeated assistant text is hidden.

| Original location and exact title | Disposition | Failure / rationale and remaining owner |
| --- | --- | --- |
| `packages/api/src/agent-chat/re-emitted.test.ts:42` — the same words in another turn are no copy, and neither is a repeat still streaming | **DELETE** | Duplicate cross-turn/streaming safeguards already exercised by the nonterminal-repeat and per-turn cases. The retained non-last-repeat case already includes a separate turn and a live final repeat; per-turn copy case covers independent turn grouping. |
| `packages/api/src/agent-chat/re-emitted.test.ts:51` — only a copy of the turn's OPENING message, at its end: a goal run's rounds may end on the same words | **KEEP** | An intermediate repeated goal-round answer is hidden instead of only the flushed opening copy. |
| `packages/api/src/agent-chat/re-emitted.test.ts:65` — a repeat of the opening that is not the turn's last message is the agent's own words | **KEEP** | A legitimate repeated opening before more assistant work is hidden. |
| `packages/api/src/agent-chat/re-emitted.test.ts:89` — word for word is the exact text, and the opening is the first FINISHED message with any text | **KEEP** | Whitespace-different, blank-opening or unfinished-opening messages are falsely deduplicated. |
| `packages/api/src/agent-chat/re-emitted.test.ts:118` — only the assistant's own messages with a turn count: a user or reasoning row, or a turnless row, is never one | **KEEP** | User/reasoning/turnless rows participate in assistant deduplication. |
| `packages/api/src/agent-chat/re-emitted.test.ts:128` — one author's messages only, in the view asked for: the parent's, or one subagent's | **KEEP** | A child message is compared with parent text or another author. |
| `packages/api/src/agent-chat/re-emitted.test.ts:150` — a copy is found per turn, in each turn it closes | **KEEP** | Only one of several affected turns has its flushed opening copy removed. |

## `roster.test.ts`

Owner: `roster.ts` (contracts also use `wire.ts`/`runtime-events.ts`; goal capability parsing uses `adapter-types.ts`). **Bar 1:** GUI §7.6 task lifecycle/usage/workflow grouping and http(s)-only run handle contract; recorded restart/resume and cap-order regressions. **Bars 4–5:** `foldSubagentActivities/deriveAgentPanelModel` is the shared stable seam; callers: Fold roster; GUI hooks; daemon leftover-work and MCP roster readers. **Bars 2–3:** the per-case failure below is checked against explicit fixture results; storage identity uses round-trip preservation. **Bar 6:** these cases own the distinct data/lifecycle edges; no stronger retained owner tests those same edge conditions at a lower seam. Risk if coverage were removed: Agent state, task count, usage totals or task navigation become incorrect.

| Original location and exact title | Disposition | Failure / rationale and remaining owner |
| --- | --- | --- |
| `packages/api/src/agent-chat/roster.test.ts:25` — builds an agent from start → progress → completion | **KEEP** | A normal task lifecycle loses metadata, final result, usage or tool progress. |
| `packages/api/src/agent-chat/roster.test.ts:47` — a task.completed {status: stopped} folds to interrupted | **KEEP** | Provider stopped status never becomes interrupted. |
| `packages/api/src/agent-chat/roster.test.ts:56` — a status that resolves through the prototype chain is not a status | **KEEP** | Prototype property names become executable/invalid statuses. |
| `packages/api/src/agent-chat/roster.test.ts:65` — progress can create an agent when its start row aged out of retention | **KEEP** | A retained progress row cannot recover a task whose start is absent. |
| `packages/api/src/agent-chat/roster.test.ts:75` — completion before start stays terminal; a late start only fills metadata | **KEEP** | A late start resurrects a completed task or fails to enrich metadata. |
| `packages/api/src/agent-chat/roster.test.ts:87` — a start row with a NEW launching call after a terminal state is a resume and reopens the run | **KEEP** | A genuinely resumed task remains failed or keeps stale result/error. |
| `packages/api/src/agent-chat/roster.test.ts:115` — a start row that names the SAME launching call after a terminal state is a late delivery | **KEEP** | The same launch redelivered after completion reopens a dead task. |
| `packages/api/src/agent-chat/roster.test.ts:128` — a shell's exit code folds as any integer | **KEEP** | A signal-killed background shell loses its signed exit code. |
| `packages/api/src/agent-chat/roster.test.ts:139` — duplicate terminal events are idempotent: timestamps do not slide | **KEEP** | A duplicate terminal frame overwrites the first status/result. |
| `packages/api/src/agent-chat/roster.test.ts:151` — a completion after a terminal task.updated still enriches result and usage | **KEEP** | Completion after terminal update loses the final result/usage. |
| `packages/api/src/agent-chat/roster.test.ts:165` — reactivation increments the run count and clears the previous result | **KEEP** | Explicit reactivation fails to increment runs or clear the prior result. |
| `packages/api/src/agent-chat/roster.test.ts:179` — idle is non-terminal: an idle agent resumes without losing identity | **KEEP** | An idle resumable task is treated as permanently terminal. |
| `packages/api/src/agent-chat/roster.test.ts:192` — usage max-merges field-wise and a partial terminal frame keeps the breakdown | **REWRITE** | Partial/duplicate cumulative usage erases breakdown or double-counts tokens. Give the late partial frame smaller input/output totals so the literal final breakdown detects shrinking counters, not merely preservation of omitted fields. |
| `packages/api/src/agent-chat/roster.test.ts:207` — metadata is never downgraded to null by a later partial event | **KEEP** | A partial update nulls known identity/model/role metadata. |
| `packages/api/src/agent-chat/roster.test.ts:219` — tool.progress is the agent-owned heartbeat and never creates a row | **KEEP** | An orphan heartbeat invents a task or an existing task loses tool progress. |
| `packages/api/src/agent-chat/roster.test.ts:234` — provider endedAt wins over ingestion time on the settling transition | **KEEP** | Ingestion time overwrites the provider authoritative completion instant. |
| `packages/api/src/agent-chat/roster.test.ts:243` — a non-http session url is dropped at the fold boundary | **KEEP** | An unsafe javascript session link crosses the public roster boundary. |
| `packages/api/src/agent-chat/roster.test.ts:256` — malformed rows are skipped individually without failing the fold | **KEEP** | One malformed task row destroys the whole roster. |
| `packages/api/src/agent-chat/roster.test.ts:269` — background rows join the roster, stamped agentKind background | **KEEP** | Background shell rows are omitted or mislabeled as agents. |
| `packages/api/src/agent-chat/roster.test.ts:284` — an unstamped row is background, and a later agent stamp promotes it | **KEEP** | An initially unstamped task never promotes to agent when identified. |
| `packages/api/src/agent-chat/roster.test.ts:293` — a stampless later row never demotes a known agent | **KEEP** | A later unstamped row demotes a known agent. |
| `packages/api/src/agent-chat/roster.test.ts:304` — a scheduled prompt folds to a loop row and an autonomous goal to a goal row, both background | **KEEP** | Legacy scheduled/goal rows become active shell tasks or lose sticky kind. |
| `packages/api/src/agent-chat/roster.test.ts:323` — a loop and a goal drive work and are no work of their own: never counted, never token-summed | **KEEP** | Driver rows double-count their child workload/tokens. |
| `packages/api/src/agent-chat/roster.test.ts:344` — a stop that left the task's process running is marked, and a new run forgets it | **KEEP** | An external process left running loses its marker or keeps that marker after revival. |
| `packages/api/src/agent-chat/roster.test.ts:370` — a dead session interrupts live rows but preserves idle and settled | **KEEP** | Session death leaves active work running or falsely interrupts idle/settled rows. |
| `packages/api/src/agent-chat/roster.test.ts:405` — a settled coordinator cascades onto members with no terminal row | **KEEP** | A finished workflow leaves missing-terminal members working forever. |
| `packages/api/src/agent-chat/roster.test.ts:417` — an attempt bump reactivates the same workflow slot exactly once | **KEEP** | A retried workflow slot counts activation twice or retains an old failure. |
| `packages/api/src/agent-chat/roster.test.ts:431` — deriveAgentPanelModel groups members by phase and keeps direct spawns | **KEEP** | Workflow phase membership/direct-spawn grouping is wrong. |
| `packages/api/src/agent-chat/roster.test.ts:448` — a member with an unknown phase index lands in unphasedMembers, never vanishes | **KEEP** | A member with an unknown phase disappears entirely. |
| `packages/api/src/agent-chat/roster.test.ts:458` — a pending workflow member counts as active work in its phase | **KEEP** | Pending phase members are reported as no active work. |
| `packages/api/src/agent-chat/roster.test.ts:471` — a workflow coordinator with members is not counted or token-summed | **KEEP** | Workflow parent aggregate usage/work counts are counted again with its members. |
| `packages/api/src/agent-chat/roster.test.ts:485` — an orphaned member falls back to the direct list | **KEEP** | A member whose coordinator is absent disappears instead of remaining accessible. |
| `packages/api/src/agent-chat/roster.test.ts:494` — direct agents stay in first-seen order as their activity changes | **KEEP** | Status/progress changes reorder visible direct agents. |
| `packages/api/src/agent-chat/roster.test.ts:508` — counts split waiting and idle out of running and settled | **KEEP** | Waiting/idle/settled/running workload counters are conflated. |
| `packages/api/src/agent-chat/roster.test.ts:523` — the roster caps at ROSTER_LIMIT, evicting live rows last | **DELETE** | Redundant cap test; newest live rows pass even if priority ranking is broken. The cap-order case owns the same bound; its fixture will also place live/idle rows before newer settled rows so priority matters. |
| `packages/api/src/agent-chat/roster.test.ts:539` — the cap evicts by rank but returns survivors in first-seen order | **REWRITE** | Crossing 100 tasks loses older live/idle work or reshuffles retained tasks. Place older running and idle tasks before newer settled tasks; assert the 100 literal expected survivors in first-seen order, making ranking failure observable. |
| `packages/api/src/agent-chat/roster.test.ts:563` — a resume reopens even when the NEW run's in-place progress row precedes the OLD run's terminal row | **KEEP** | Stable in-place new-run progress masks a genuine relaunch under the same task ID. |

## `slim.test.ts`

Owner: `slim.ts` (contracts also use `wire.ts`/`runtime-events.ts`; goal capability parsing uses `adapter-types.ts`). **Bar 1:** GUI §5.6 wire projection: allowlist, 16 KiB UTF-8 strings, 84-character previews, changed-file bounds; goals §4.3. **Bars 4–5:** `slimActivityPayload` is the shared stable seam; callers: Daemon read projections/ingestion and client activity stream. **Bars 2–3:** the per-case failure below is checked against explicit fixture results; storage identity uses round-trip preservation. **Bar 6:** these cases own the distinct data/lifecycle edges; no stronger retained owner tests those same edge conditions at a lower seam. Risk if coverage were removed: Huge payloads cross the wire or full-output/failed-tool/goal/task metadata is lost.

| Original location and exact title | Disposition | Failure / rationale and remaining owner |
| --- | --- | --- |
| `packages/api/src/agent-chat/slim.test.ts:20` — a non-record payload passes through | **KEEP** | Primitive/unknown activity payloads are coerced or crash the wire projection. |
| `packages/api/src/agent-chat/slim.test.ts:26` — summarizeToolTextOutput takes the first meaningful line, elided at 84 | **REWRITE** | A long command preview exceeds the specified 84-character wire summary bound. Assert the bounded preview through slimActivityPayload, the production wire seam; remove the test-only helper export. |
| `packages/api/src/agent-chat/slim.test.ts:34` — summarizeToolTextOutput falls back to an N-lines count | **REWRITE** | Unrenderable multiline output loses the specified count fallback or fabricates a blank summary. Assert the multiline fallback through slimActivityPayload; remove the test-only helper export. |
| `packages/api/src/agent-chat/slim.test.ts:40` — tool output is summarised and the row is flagged truncated | **KEEP** | Wire tool output remains huge or loses the full-output availability flag. |
| `packages/api/src/agent-chat/slim.test.ts:57` — an MCP tool call keeps only the allow-listed item fields | **KEEP** | MCP private/bulky fields leak while public call/result fields are lost. |
| `packages/api/src/agent-chat/slim.test.ts:89` — changed files are promoted to a bounded top-level path list | **KEEP** | Changed-file promotion exceeds its public bound or loses the first path. |
| `packages/api/src/agent-chat/slim.test.ts:103` — a changed-file path deeper than the depth bound is not collected | **KEEP** | Deep nested data defeats the changed-file traversal bound. |
| `packages/api/src/agent-chat/slim.test.ts:113` — a completed payload over a failed item is re-stamped failed | **KEEP** | A failed nested command is displayed as successful. |
| `packages/api/src/agent-chat/slim.test.ts:124` — a declined nested item re-stamps too, and a real success is left alone | **KEEP** | A declined call is displayed as successful or a real success is relabeled. |
| `packages/api/src/agent-chat/slim.test.ts:139` — every string is capped at 16 KiB and the row flagged truncated | **DELETE** | Duplicate ASCII top-level cap covered by compaction/prompt fields and UTF-8 cap tests. Compaction/launch-prompt tests pin the ASCII 16 KiB cap; UTF-8 detail test covers the data-present projection path. |
| `packages/api/src/agent-chat/slim.test.ts:147` — a compaction summary survives slimming, capped and flagged | **KEEP** | Compaction summaries disappear or bypass the wire size cap. |
| `packages/api/src/agent-chat/slim.test.ts:166` — an agent's launch prompt survives slimming, capped and flagged, beside its at-rest mark | **KEEP** | Launch prompt/at-rest truncation metadata disappears from agent drill-in data. |
| `packages/api/src/agent-chat/slim.test.ts:189` — the cap counts UTF-8 bytes, not UTF-16 code units | **KEEP** | CJK/emoji strings exceed the byte cap or end in broken surrogate pairs. |
| `packages/api/src/agent-chat/slim.test.ts:206` — a multi-byte string below the wire cap stays complete | **KEEP** | A valid multibyte string under the cap is unnecessarily shortened/flagged. |
| `packages/api/src/agent-chat/slim.test.ts:213` — the task linkage bundle survives slimming so the roster still folds | **KEEP** | Task linkage/model fields disappear before client roster derivation. |
| `packages/api/src/agent-chat/slim.test.ts:230` — a goal row's payload survives slimming whole: goal, change and previous (goals §4.3) | **KEEP** | Current/previous/null goal state disappears during wire projection. |
| `packages/api/src/agent-chat/slim.test.ts:250` — a goal row's strings meet the same wire cap as every other string, and nothing else moves | **KEEP** | Nested lastCheck strings bypass the cap or produce an invalid goal update. |
| `packages/api/src/agent-chat/slim.test.ts:271` — a small tool row that loses nothing is not flagged truncated | **KEEP** | An unchanged small row falsely promises more output on the host. |
| `packages/api/src/agent-chat/slim.test.ts:285` — ACP content blocks are summarised | **KEEP** | ACP content blocks fail to produce a tool output preview. |

## `turn-state.test.ts`

Owner: `turn-state.ts` (contracts also use `wire.ts`/`runtime-events.ts`; goal capability parsing uses `adapter-types.ts`). **Bar 1:** GUI §5.1/§6.4 turn settlement by session state, once only. **Bars 4–5:** `applySessionStatusToTurn` is the shared stable seam; callers: fold.ts sessionSetTurns; deriveLatestTurn has no production caller. **Bars 2–3:** the per-case failure below is checked against explicit fixture results; storage identity uses round-trip preservation. **Bar 6:** these cases own the distinct data/lifecycle edges; no stronger retained owner tests those same edge conditions at a lower seam. Risk if coverage were removed: Turn duration drifts after settlement or a send failing before a provider ID stays pending.

| Original location and exact title | Disposition | Failure / rationale and remaining owner |
| --- | --- | --- |
| `packages/api/src/agent-chat/turn-state.test.ts:28` — a settled turn never moves again: a late transition cannot extend it | **KEEP** | A late session transition changes a settled state/end time. |
| `packages/api/src/agent-chat/turn-state.test.ts:38` — a pending turn (no turn id yet) settles too | **KEEP** | A failed send before provider turn assignment remains pending. |
| `packages/api/src/agent-chat/turn-state.test.ts:47` — deriveLatestTurn reads the last row, or null | **DELETE** | Dead helper projection has no production caller; behavior is not consumed. deriveLatestTurn is imported only by tests (other matches are prose); delete the dead implementation and inspect folded turns directly. |

## `turns.test.ts`

Owner: `turns.ts` (contracts also use `wire.ts`/`runtime-events.ts`; goal capability parsing uses `adapter-types.ts`). **Bar 1:** GUI §5.5 turn-order rewind ordinals, independent of sparse checkpoints. **Bars 4–5:** `startedTurns/turnOrdinal` is the shared stable seam; callers: Daemon orchestrator/index/MCP and UI rewind/history readers. **Bars 2–3:** the per-case failure below is checked against explicit fixture results; storage identity uses round-trip preservation. **Bar 6:** these cases own the distinct data/lifecycle edges; no stronger retained owner tests those same edge conditions at a lower seam. Risk if coverage were removed: Duplicate or pending turns shift the requested rewind target.

| Original location and exact title | Disposition | Failure / rationale and remaining owner |
| --- | --- | --- |
| `packages/api/src/agent-chat/turns.test.ts:20` — startedTurns keeps only rows with a provider turn id, in order | **DELETE** | Duplicate filtering/order coverage already proved by duplicate-id and ordinal cases. The ordinal case already places a pending row between two started IDs and verifies order; duplicate-id case checks the direct filtered list. |
| `packages/api/src/agent-chat/turns.test.ts:28` — a duplicate id counts once, so later ordinals stay aligned | **KEEP** | A replayed turn ID shifts every later rewind ordinal. |
| `packages/api/src/agent-chat/turns.test.ts:37` — turnOrdinal is 1-based and null for a pending or unknown turn | **KEEP** | Pending/unknown turns receive a real ordinal or numbering is zero-based. |

## Disposition totals

KEEP: 248, DELETE: 9, REWRITE: 16 original declarations. Parameterized cases remain together; no test is added.

Additional pre-edit review: the replay test seed could mask ignoring its resolution row; the usage fixture did not distinguish maximum merge from replacement. Both real contracts are retained with discriminating input at the existing public seam.

Seam caller audit: `deriveLatestTurn` has no non-test call sites (three prose references are being corrected by adjacent owners). `summarizeToolTextOutput` is called only by local slimming projection functions. `requestKindFromRequestType` and `parseQuestions` are called only by local `derivePendingRequests`. No consumer needs those three exports. The shared test builders remain referenced by retained behavior tests; no external fixtures or snapshots became unused.

## Completed cleanup and validation

- Audited every original declaration: **248 KEEP, 9 DELETE, 16 REWRITE**. Original 273 declarations / 275 runtime cases become 264 declarations / 266 runtime cases. No additional test was introduced; rewrites preserve existing independently specified contracts.
- Net test change: **211 lines removed** (62 added, 273 removed). Including the dead production helper/export cleanup: **233 net lines removed** (65 added, 298 removed), excluding this required audit ledger.
- Removed `deriveLatestTurn` entirely; made `requestKindFromRequestType`, `parseQuestions`, and `summarizeToolTextOutput` private. Production callers use the containing public fold/pending/slimming interfaces. Adjacent owners corrected obsolete prose references to `deriveLatestTurn`; no references remain under apps/packages.
- No fixture, snapshot or shared builder became unused. No runtime behavior was changed, no test-count/coverage gate was relaxed, and no baseline product failure was hidden.
- Baseline: `pnpm exec node --import tsx --import ../../scripts/test/assert-ok.mjs --test src/agent-chat/*.test.ts` from `packages/api`: **275 passed, 0 failed**.
- Focused changed files: `pnpm exec node --import tsx --import ../../scripts/test/assert-ok.mjs --test --test-concurrency=1 src/agent-chat/{command-output,failure-reason,fold-snapshot,fold.goal,fold,pending,re-emitted,roster,slim,turn-state,turns}.test.ts`: **181 passed, 0 failed**. Serial execution avoided multiplying repository-wide parallel load.
- Final-review edits were rechecked with `pnpm exec node --import tsx --import ../../scripts/test/assert-ok.mjs --test src/agent-chat/command-output.test.ts src/agent-chat/fold-snapshot.test.ts`: **38 passed, 0 failed**.
- `pnpm typecheck` from `packages/api`: passed. Final `git diff --check -- packages/api/src/agent-chat docs/test-cleanup/api-chat.md`: passed. The full scoped source diff was reviewed; root-agent repository gates, merge and push are tracked in the aggregate cleanup report.

No scoped verification remains blocked. Export removal is limited to helpers with zero external production callers; public protocol/storage behavior and the sole Codex wire-projection case remain protected.
