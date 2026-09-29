# Codex adapter test cleanup

Completed cleanup; dispositions were recorded before their corresponding edits. Scope: all 13 original test files under `apps/daemon/src/agent-host/adapters/codex`; 351 test declarations / 395 expanded baseline tests. All original tests and their production owners were read. Generated bindings are unchanged.

Baseline: full scoped command passed 395/395; independent mapping/goal/unit run passed 130/130. No retained baseline failure was found.

## Six-bar retention evidence

The following applies to each KEEP/REWRITE row in the corresponding file; the row names the distinct required failure. Parameterized rows cover every original case unless an explicit case split is given below.

### `child-items.test.ts`

1. Independent source: [GUI design](../superpowers/specs/2026-09-21-agent-chat-gui-design.md) child ownership and fixture README observation 24; RuntimeEvent item/task ownership. 2. Recognizable failure: child tool output, status and parent-turn attribution, concretized by each case below. 4. Stable seam: normalise.ts and ingestion/fold. 6. This seam owns these distinct cases: transport tests own framing, translator tests own exhaustive protocol values, replay owns captured normalization, and session tests own wire/lifecycle integration. Cases retained at multiple seams exercise different failure conditions; the per-case deletions below remove repeated scenarios. Risk: deleting its unique failure would lose the behavior named by that row; retained risk is low with focused validation.

### `child-question.test.ts`

1. Independent source: [GUI design](../superpowers/specs/2026-09-21-agent-chat-gui-design.md) question workflow and observed child-outliving-parent regression. 2. Recognizable failure: an orphaned child question or an answer never reaching its provider, concretized by each case below. 4. Stable seam: real orchestrator + child process + durable event log. 6. This seam owns these distinct cases: transport tests own framing, translator tests own exhaustive protocol values, replay owns captured normalization, and session tests own wire/lifecycle integration. Cases retained at multiple seams exercise different failure conditions; the per-case deletions below remove repeated scenarios. Risk: deleting its unique failure would lose the behavior named by that row; retained risk is low with focused validation.

### `child-routing.test.ts`

1. Independent source: shared RuntimeEvent parent ownership, fixture README observations 22/24. 2. Recognizable failure: child events changing parent state or prematurely completing another turn/item, concretized by each case below. 4. Stable seam: CodexNormaliser event output. 6. This seam owns these distinct cases: transport tests own framing, translator tests own exhaustive protocol values, replay owns captured normalization, and session tests own wire/lifecycle integration. Cases retained at multiple seams exercise different failure conditions; the per-case deletions below remove repeated scenarios. Risk: deleting its unique failure would lose the behavior named by that row; retained risk is low with focused validation.

### `collab-relaunch.test.ts`

1. Independent source: [GUI design](../superpowers/specs/2026-09-21-agent-chat-gui-design.md) §7.6, fixture observations of subAgentActivity and child turn ordering. 2. Recognizable failure: lost/reused task identity, premature child settlement or a prompt attributed to the wrong run, concretized by each case below. 4. Stable seam: CodexNormaliser event output and folded task records. 6. This seam owns these distinct cases: transport tests own framing, translator tests own exhaustive protocol values, replay owns captured normalization, and session tests own wire/lifecycle integration. Cases retained at multiple seams exercise different failure conditions; the per-case deletions below remove repeated scenarios. Risk: deleting its unique failure would lose the behavior named by that row; retained risk is low with focused validation.

### `completion-output.test.ts`

1. Independent source: [GUI design](../superpowers/specs/2026-09-21-agent-chat-gui-design.md) bounded output contract: 64 KiB and valid UTF-8 in live and hydrated tools. 2. Recognizable failure: unbounded, split-codepoint or missing tool output, concretized by each case below. 4. Stable seam: live normalization and historical projection. 6. This seam owns these distinct cases: transport tests own framing, translator tests own exhaustive protocol values, replay owns captured normalization, and session tests own wire/lifecycle integration. Cases retained at multiple seams exercise different failure conditions; the per-case deletions below remove repeated scenarios. Risk: deleting its unique failure would lose the behavior named by that row; retained risk is low with focused validation.

### `goal.test.ts`

1. Independent source: [goals design](../superpowers/specs/2026-09-24-agent-goals-design.md) §6.2 status, counters, restoration, carry and explicitly specified summary grammar. 2. Recognizable failure: incorrect goal state, counter conversion, duplicate transitions, stale reply or lost restoration, concretized by each case below. 4. Stable seam: goal translator/tracker and normalization. 6. This seam owns these distinct cases: transport tests own framing, translator tests own exhaustive protocol values, replay owns captured normalization, and session tests own wire/lifecycle integration. Cases retained at multiple seams exercise different failure conditions; the per-case deletions below remove repeated scenarios. Risk: deleting its unique failure would lose the behavior named by that row; retained risk is low with focused validation.

### `history.test.ts`

1. Independent source: [GUI design](../superpowers/specs/2026-09-21-agent-chat-gui-design.md) durable historical projection and Codex hydrated thread protocol. 2. Recognizable failure: lost text/tool references, wrong turn ordering, invented costs or dropped malformed-neighbor records, concretized by each case below. 4. Stable seam: projectCodexHistory public adapter projection. 6. This seam owns these distinct cases: transport tests own framing, translator tests own exhaustive protocol values, replay owns captured normalization, and session tests own wire/lifecycle integration. Cases retained at multiple seams exercise different failure conditions; the per-case deletions below remove repeated scenarios. Risk: deleting its unique failure would lose the behavior named by that row; retained risk is low with focused validation.

### `mapping.test.ts`

1. Independent source: [GUI design](../superpowers/specs/2026-09-21-agent-chat-gui-design.md) §§4.3–4.5 and generated Codex approval/sandbox/user-input protocol enums. 2. Recognizable failure: wrong security grant, request refusal, unusable question or unsafe resume identifier, concretized by each case below. 4. Stable seam: pure protocol translators; rewritten question/cursor cases use session wire. 6. This seam owns these distinct cases: transport tests own framing, translator tests own exhaustive protocol values, replay owns captured normalization, and session tests own wire/lifecycle integration. Cases retained at multiple seams exercise different failure conditions; the per-case deletions below remove repeated scenarios. Risk: deleting its unique failure would lose the behavior named by that row; retained risk is low with focused validation.

### `probe-child.test.ts`

1. Independent source: provider lifecycle contract and documented immediate-child-exit regression. 2. Recognizable failure: a dead probe retaining a 30-second pending handshake timer, concretized by each case below. 4. Stable seam: createCodexAdapter snapshot promise. 6. This seam owns these distinct cases: transport tests own framing, translator tests own exhaustive protocol values, replay owns captured normalization, and session tests own wire/lifecycle integration. Cases retained at multiple seams exercise different failure conditions; the per-case deletions below remove repeated scenarios. Risk: deleting its unique failure would lose the behavior named by that row; retained risk is low with focused validation.

### `protocol.test.ts`

1. Independent source: Codex NDJSON JSON-RPC envelopes and request/reply/error semantics. 2. Recognizable failure: wrong envelopes, lost requests, blocked read loop, leaked slots or unrejected shutdown promises, concretized by each case below. 4. Stable seam: CodexPeer with real readable/writable streams. 6. This seam owns these distinct cases: transport tests own framing, translator tests own exhaustive protocol values, replay owns captured normalization, and session tests own wire/lifecycle integration. Cases retained at multiple seams exercise different failure conditions; the per-case deletions below remove repeated scenarios. Risk: deleting its unique failure would lose the behavior named by that row; retained risk is low with focused validation.

### `replay.test.ts`

1. Independent source: redacted real captures with provenance in provider fixture README. 2. Recognizable failure: misread actual CLI frames, merged distinct assistant messages, wrong errors/usage or lost lifecycle events, concretized by each case below. 4. Stable seam: normalizer outputs, ingestion and fold for multi-message integration. 6. This seam owns these distinct cases: transport tests own framing, translator tests own exhaustive protocol values, replay owns captured normalization, and session tests own wire/lifecycle integration. Cases retained at multiple seams exercise different failure conditions; the per-case deletions below remove repeated scenarios. Risk: deleting its unique failure would lose the behavior named by that row; retained risk is low with focused validation.

### `session.test.ts`

1. Independent source: AgentAdapter/CodexSession contract, GUI §§3–4 and goals §6.2 plus child lifecycle regressions. 2. Recognizable failure: malformed outbound bytes, wrong approval/answer ownership, hung session, lost Stop/exit, stale goal state or incorrect history selection, concretized by each case below. 4. Stable seam: real spawned scripted wire peer and emitted RuntimeEvents. 6. This seam owns these distinct cases: transport tests own framing, translator tests own exhaustive protocol values, replay owns captured normalization, and session tests own wire/lifecycle integration. Cases retained at multiple seams exercise different failure conditions; the per-case deletions below remove repeated scenarios. Risk: deleting its unique failure would lose the behavior named by that row; retained risk is low with focused validation.

### `units.test.ts`

1. Independent source: [GUI design](../superpowers/specs/2026-09-21-agent-chat-gui-design.md) §§4.5/4.6/7.6, generated item variants, provider usage units and bounded async stream contract. 2. Recognizable failure: wrong item bucket, double-counted/reset usage, missing skill/catalog values, invalid home, reordered events or parked consumer, concretized by each case below. 4. Stable seam: production-used item/usage/skill transformations, public adapter startSession/refreshSnapshot and async iterator. 6. This seam owns these distinct cases: transport tests own framing, translator tests own exhaustive protocol values, replay owns captured normalization, and session tests own wire/lifecycle integration. Cases retained at multiple seams exercise different failure conditions; the per-case deletions below remove repeated scenarios. Risk: deleting its unique failure would lose the behavior named by that row; retained risk is low with focused validation.

## Per-test dispositions

| Disposition | Original path and test | Failure / remaining owner |
|---|---|---|
| DELETE | `apps/daemon/src/agent-host/adapters/codex/child-items.test.ts:342` — Stop and exit close a child's running call; a turn-scoped close of the parent's turn does not | Session-scoped Stop closes a child command before its task in session.test.ts; the direct registry-close invocation duplicates that stronger owner. |
| DELETE | `apps/daemon/src/agent-host/adapters/codex/child-routing.test.ts:274` — a new message of the same turn closes the abandoned one first, text-less | Recorded abandoned-message replay exercises this same message replacement with observed wire frames. |
| DELETE | `apps/daemon/src/agent-host/adapters/codex/child-routing.test.ts:312` — never closes an open TOOL item — parallel calls overlap | Recorded corpus closes only the abandoned assistant message while overlapping tools remain open; this synthetic duplicate adds no distinct output contract. |
| DELETE | `apps/daemon/src/agent-host/adapters/codex/collab-relaunch.test.ts:152` — subAgentActivity started starts the task under codex-launch:<item id> | Asserts a private minted task-id prefix. Remaining first-turn and relaunch tests protect stable ownership and fresh-run identity. |
| DELETE | `apps/daemon/src/agent-host/adapters/codex/goal.test.ts:404` — is settled only once no snapshot is pending and no carry is in flight | Asserts transient internal settled getter shape. Actual session account-switch commands exercise the required waiting and successful carry behavior. |
| DELETE | `apps/daemon/src/agent-host/adapters/codex/goal.test.ts:417` — a failed carry settles too | Same private settled getter; session failed-carry regression checks caller-visible clear and warning. |
| DELETE | `apps/daemon/src/agent-host/adapters/codex/history.test.ts:72` — brackets every turn with turn.started … turn.completed | Multi-turn history ordering test checks paired boundaries and ordering, subsuming this one-turn count. |
| DELETE | `apps/daemon/src/agent-host/adapters/codex/mapping.test.ts:42` — acceptAlways takes the execpolicy amendment when the server proposed one | Session acceptAlways wire test checks the actual amendment sent to Codex. |
| REWRITE | `apps/daemon/src/agent-host/adapters/codex/mapping.test.ts:67` — answers item/permissions/requestApproval with scope:'session' only for acceptForSession | Rename misleading scope claim; assertions cover turn/session grants, not every accepted enum. |
| DELETE | `apps/daemon/src/agent-host/adapters/codex/mapping.test.ts:88` — renders the provider's own set when one is advertised | Session advertised-options test protects displayed decisions and the wire answer. |
| REWRITE | `apps/daemon/src/agent-host/adapters/codex/mapping.test.ts:101` — maps the network-policy amendment arm with its own caution | Check caution presence, not incidental English wording. |
| DELETE | `apps/daemon/src/agent-host/adapters/codex/mapping.test.ts:109` — falls back to the default four when nothing is advertised | Static default inventory is covered by session file-change default-options behavior. |
| DELETE | `apps/daemon/src/agent-host/adapters/codex/mapping.test.ts:194` — always sends a collaborationMode, default included | Computes an object but claims to send it; session consecutive-turn test observes the outbound default and plan settings. |
| REWRITE | `apps/daemon/src/agent-host/adapters/codex/mapping.test.ts:223` — a cursor that fails its own shape check means 'no resume', NEVER an error | Move malformed cursor matrix to real session.start wire behavior and privatize cursor parser. |
| DELETE | `apps/daemon/src/agent-host/adapters/codex/mapping.test.ts:248` — keys on `question`, not `prompt` | Question field name is already checked at session user-input.requested seam. |
| REWRITE | `apps/daemon/src/agent-host/adapters/codex/mapping.test.ts:255` — drops a question missing id, header or question text | Move malformed question rejection to session wire boundary. |
| REWRITE | `apps/daemon/src/agent-host/adapters/codex/mapping.test.ts:266` — drops an option whose label or description is empty | Move invalid option filtering to emitted question card. |
| REWRITE | `apps/daemon/src/agent-host/adapters/codex/mapping.test.ts:280` — keeps a free-text-only question when isOther is set (options is nullable) | Move nullable options/custom-answer behavior to session wire boundary. |
| REWRITE | `apps/daemon/src/agent-host/adapters/codex/mapping.test.ts:288` — drops an option-less question that is NOT isOther | Move optionless rejection to session wire boundary. |
| REWRITE | `apps/daemon/src/agent-host/adapters/codex/mapping.test.ts:297` — carries isOther and isSecret through in the provider's own spelling (W13) | Move secret/custom flags to emitted card boundary. |
| DELETE | `apps/daemon/src/agent-host/adapters/codex/mapping.test.ts:309` — hard-codes multiSelect false — the field does not exist on the wire | Blocking-question session test asserts multiSelect false and actual label answer. |
| REWRITE | `apps/daemon/src/agent-host/adapters/codex/mapping.test.ts:316` — answers with the LABEL, in T3's accepted shape | Move array-label answer mapping to actual wire replies; existing session covers a single label. |
| REWRITE | `apps/daemon/src/agent-host/adapters/codex/mapping.test.ts:325` — omits an unanswered question rather than sending it empty | Move omitted blank answers to actual wire replies. |
| REWRITE | `apps/daemon/src/agent-host/adapters/codex/replay.test.ts:154` — emits thread.started with the provider thread id from result.thread.id | Correct title: thread.started comes from observed thread/started notification, not an initialize response. |
| DELETE | `apps/daemon/src/agent-host/adapters/codex/replay.test.ts:242` — the diff arrives on the fileChange ITEM, not on the approval request | Only checks a nonempty diff/path from a fixture; session file-change approval joins concrete path/diff by itemId and catches the real card failure. |
| DELETE | `apps/daemon/src/agent-host/adapters/codex/replay.test.ts:411` — through ingestion and the fold, every agentMessage item is its own message — nothing glued | Shared ingestion assistant-phase all-captures oracle checks each raw item id and exact text, including the three messages in fixture 05. |
| DELETE | `apps/daemon/src/agent-host/adapters/codex/replay.test.ts:425` — a regenerated FINAL answer keeps its own phase; the abandoned attempt stays commentary | Shared ingestion D4 synthetic real-normalizer/fold case checks split text, commentary/final phase and close ordering, subsuming this phase-mutated fixture. |
| DELETE | `apps/daemon/src/agent-host/adapters/codex/replay.test.ts:469` — an unprompted compaction mid-turn still produces the compacted state | Duplicates recorded native-compaction state emission already checked in this file. |
| DELETE | `apps/daemon/src/agent-host/adapters/codex/session.test.ts:332` — a second sendTurn during a live turn reuses the active turn id | Mock implements reuse of active turn id and test echoes its arranged result. Steering usage baseline test retains the distinct adapter behavior. |
| DELETE | `apps/daemon/src/agent-host/adapters/codex/session.test.ts:726` — a stale turn id is a client-side no-op, never a -32600 on the wire | Later stale Stop goal regression verifies both no interruption and no goal mutation. |
| DELETE | `apps/daemon/src/agent-host/adapters/codex/session.test.ts:789` — interrupting when no turn is active does nothing at all | No-live-turn branch is covered by session-scoped fleet/goal Stop tests and stale Stop guard. |
| DELETE | `apps/daemon/src/agent-host/adapters/codex/session.test.ts:1028` — a child's command the user declined is the user's decline, never a policy deny | The later decline after parent settlement protects the same classification under a stronger lifecycle condition. |
| DELETE | `apps/daemon/src/agent-host/adapters/codex/session.test.ts:1054` — a child's file-change card carries the child's path and diff | Later child remembered-diff test protects the same path/diff card after parent settlement. |
| REWRITE | `apps/daemon/src/agent-host/adapters/codex/session.test.ts:2108` — a malformed cursor means 'no resume', never an error | Exercise the entire rejected cursor input matrix through session.start; remove direct parser export. |
| DELETE | `apps/daemon/src/agent-host/adapters/codex/session.test.ts:2125` — thread/compact/start runs as a whole extra turn and lands the compacted state | Scripted peer manufactures compact turn lifecycle; recorded native-compaction replay owns mapping. |
| DELETE | `apps/daemon/src/agent-host/adapters/codex/session.test.ts:2264` — readThread hydrates history out of band | Rollback tests hydrate actual returned history while checking selected turns and resulting ids. |
| REWRITE | `apps/daemon/src/agent-host/adapters/codex/session.test.ts:2332` — logs every frame in both directions to the raw sink | Correct overclaim: asserts frames in both directions under the owning thread, not every frame. |
| DELETE | `apps/daemon/src/agent-host/adapters/codex/session.test.ts:2456` — status names the goal the provider holds | Mocks the goal it then expects summarized; pure summary contract tests and stale-get session regression own the meaningful behavior. |
| DELETE | `apps/daemon/src/agent-host/adapters/codex/session.test.ts:3226` — the progress throttle reads the context's clock, not the wall clock | Checks injected-clock collaborator wiring. Pure goal throttle boundary tests own the actual contract. |
| REWRITE | `apps/daemon/src/agent-host/adapters/codex/units.test.ts:68` — ${testCase.item.type} → ${testCase.itemType} | Remove dead timelineBypass metadata and duplicate classification cases; keep only mappings not asserted by recorded normalizer/history owners. |
| DELETE | `apps/daemon/src/agent-host/adapters/codex/units.test.ts:92` — a commentary agentMessage keeps its phase for live and replayed display | Recorded regenerated-answer replay protects actual commentary/final phase propagation. |
| DELETE | `apps/daemon/src/agent-host/adapters/codex/units.test.ts:380` — NEVER synthesises a provider /effort — it is client-only (§4.6.5(a)) | Static command inventory compares a constant copy with its declaration; wrapper ignores its models input. |
| REWRITE | `apps/daemon/src/agent-host/adapters/codex/units.test.ts:428` — expands ~ and ~/ because spawn does NOT shell-expand an env value | Check expanded tilde and absolute homes via public startSession and initialize result from the actual child environment; privatize resolveCodexHome. |
| DELETE | `apps/daemon/src/agent-host/adapters/codex/units.test.ts:435` — passes an absolute path verbatim and refuses a relative one | Private parser return is not a rejected home: adapter forwards an unnormalized relative home to buildEnv. Absolute-home success is covered by the rewritten public startSession test; undefined is not a StartSessionInput home path. |
| REWRITE | `apps/daemon/src/agent-host/adapters/codex/units.test.ts:464` — a probe that comes back empty NEVER blanks a non-empty cached list | Check warmed catalogs survive an empty real probe via adapter.refreshSnapshot; privatize mergeSnapshot. |
| REWRITE | `apps/daemon/src/agent-host/adapters/codex/units.test.ts:474` — keeps at most 16 cwd overlays, oldest evicted | Check independent 16-cwd retention limit via public snapshots after actual probes. |
| REWRITE | `apps/daemon/src/agent-host/adapters/codex/units.test.ts:497` — re-probing a cwd refreshes it in place rather than duplicating it | Check changed skills replace a re-probed cwd without duplicate overlays via public snapshots. |
| REWRITE | `apps/daemon/src/agent-host/adapters/codex/units.test.ts:515` — an empty overlay keeps the previous one for that cwd | Combine with warmed empty-probe scenario and assert cwd-specific skills survive. |

Classification-table case split: DELETE userMessage, agentMessage, reasoning, plan, commandExecution, fileChange, mcpToolCall, enteredReviewMode, exitedReviewMode, contextCompaction, subAgentActivity, hookPrompt (recorded replay/history/child-item normalization owns these outputs). KEEP dynamicToolCall, collabAgentToolCall, webSearch, imageView, sleep (remaining coverage lacks these normalized item buckets). All retained table cases assert independent runtime item enum values and unknown-type handling; none retains unused timeline metadata.

## Production callers and support

- `ClassifiedItem.timelineBypass` has no production reader: normalizer emits item payloads without it and historical projection uses item-type ownership. Remove this local field and values; shared API/UI timelineBypass is unrelated and retained.
- `codexSlashCommands(models)` ignores its only argument and returns a constant copy. Its sole production caller is `probeCodex`; inline that copy and remove export/wrapper.
- `session.ts` question/answer/cursor helpers are called internally; direct test exports become unnecessary after wire-boundary rewrites. Remove exports, preserve algorithms.
- `normalise.ts` `toAsyncUserInputQuestions` and `failureReasonOf` have internal callers only: remove exports.
- `fold-testing.ts` `loggedActivities` has no callers; remove helper/import. Make its locally used thread-id constant private.
- `testing.ts` `readReceived` has only local wrapper callers: remove export.
- `decisions.ts` `FILE_CHANGE_APPROVAL_OPTIONS` is an unused alias: remove it.
- Every recorded fixture remains exercised by retained corpus replay; none can be removed.
- Snapshot/home transforms remain used internally; direct helper tests move to public adapter startSession/refreshSnapshot and their test-only exports are removed. Relative-home parser test deleted because its claimed refusal is not caller-visible.

## Validation

Focused command (from `apps/daemon`): `pnpm exec node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test --test-concurrency=1 src/agent-host/adapters/codex/*.test.ts`.
After the main pruning/rewrites, the complete scoped run passed **352/352** (no skips/failures). The final replay and public-adapter/unit changes passed **60/60** using the same command with only `replay.test.ts units.test.ts`. The final inventory is **348 expanded tests** across 13 files (316 declarations): 29 original declarations DELETE, 19 original declarations REWRITE, 303 original declarations KEEP; the rewritten classification table additionally deletes 12 duplicated expanded cases. Seven public-boundary replacement declarations consolidate previously exported helper contracts, rather than adding scenarios.

The integration-only replay fixture mutation, raw-text oracle, fold driver, fake clock hooks and unused fixture read were removed with the two ingestion-owned duplicates. The scripted compaction branch was removed with its mock-implemented scenario. The existing scripted peer now carries raw nullable/secret question values and selectable catalog response data to reach public adapter boundaries; it implements no filtering, home normalization, cache retention or deduplication under assertion.

The retained child-question workflow produced `/var/lib/orquester/tmp/codex-child-question-NqdqQ4/answered-question.json`, containing durable events and provider wire evidence. No provider captures or generated bindings changed. All changes in production modules remove unused metadata/aliases/wrappers or unneeded exports; runtime protocol handling is unchanged.

Scoped final diff and `git diff --check` reviewed. Initial daemon typecheck reported concurrent edits outside this scope; a later pass also caught a removed type import and ES2022/API typing in the new public-boundary setup, corrected before completion. Final typecheck result is recorded below. Parent owns required `pnpm check`, `pnpm test`, final integrated diff, remote-test audit, commit and push.

Final daemon typecheck: **PASS**, `pnpm exec tsc --noEmit -p apps/daemon/tsconfig.json` (exit 0). Strict unused-symbol scan found no unused Codex symbols. Final scoped diff: **−663 test LOC**, **−727 source/support/test LOC** (report excluded).
