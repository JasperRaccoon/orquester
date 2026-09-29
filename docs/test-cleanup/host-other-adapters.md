# Shared and Claude adapter test cleanup

Scope: all original `apps/daemon/src/agent-host/adapters/*.test.ts` and `claude/*.test.ts`. OpenCode, Codex and Grok are audited separately. Status: completed cleanup. Dispositions below were recorded after test/owner/caller review and before editing. No daemon or live provider is started.

Original declaration inventory: 457 (parameterized declarations represent every generated fixture/provider case): **37 DELETE, 4 REWRITE, 416 KEEP**. The final source contains 420 declarations; no KEEP declaration disappeared and no DELETE declaration remains.

Independent requirements referenced below: `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md`, `docs/superpowers/specs/2026-09-24-agent-goals-design.md`, the captured protocol observations in `apps/daemon/test/fixtures/claude/README.md`, the installed SDK wire types, and the security/persistence rules in `AGENTS.md`.

Validation command (V): from repository root, `node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/agent-host/adapters/*.test.ts apps/daemon/src/agent-host/adapters/claude/*.test.ts`. Repository gates are run by the root cleanup agent.

A KEEP/REWRITE row inherits its file’s six numbered bar justifications, then names its exact independently detectable failure in the test title. Risk for retained rows: loss/misrouting of the stated caller-visible behavior; risk for deletions: low because their stronger owners are identified in each reason. All rows use V; no deletion is justified by count or coverage.

## `apps/daemon/src/agent-host/adapters/attachment-lines.test.ts`

Production owner read: `attachment-lines.ts`. Non-test callers: all four adapter send paths, Claude/OpenCode/Codex history, orchestrator answer formatting.

1. Independent source: Attachment prompt bytes and replay compatibility (§4.1, §4.5, §4.6.8/9, §6.2); filename line-injection and exponential-regex regression.
2. Caller-visible failure: the particular missing/wrong response, persisted read, permission, state or content identified by each retained test title below.
3. Independent oracle: literal prompt strings and hostile filenames; expected outcomes are not obtained by asking the owner to compute them.
4. Stable seam: shared text/byte formatting functions.
5. Refactor survival: assertions address that input/output contract rather than source identifiers, internal call order, CSS or module/export inventories.
6. Lowest distinct owner: provider tests retain only delivery and provider block selection, not these formatting combinations.

| Disposition | Original test / exact failure it detects | Reason / stronger remaining coverage |
|---|---|---|
| DELETE | never prefixes or wraps: a leading slash command stays first (§4.6.9) | Duplicate suffix formatting assertion: the first format test fixes the appended position; Claude lifecycle sends a literal /review with an image and file and asserts the SDK text. No distinct bug is lost. |
| REWRITE | removes one trailing block in the helper's own shape and nothing else | Replace setup through appendAttachmentPathLines with literal persisted prompt bytes. A writer and reader changing together must not make old native history unreadable. |
| REWRITE | is true for exactly the block `appendAttachmentPathLines` writes onto empty prose | Use literal one/multiple-file persisted blocks instead of manufacturing accepted input with the companion writer; keep the colon-in-name edge. |

## `apps/daemon/src/agent-host/adapters/auth-status.test.ts`

Production owner read: `claude/probe.ts; codex/probe.ts; opencode/snapshot.ts`. Non-test callers: provider snapshot builders and auth notice/workflow consumers.

1. Independent source: §7.7 ambiguity must not become a signed-out verdict, with documented false-sign-in regression.
2. Caller-visible failure: the particular missing/wrong response, persisted read, permission, state or content identified by each retained test title below.
3. Independent oracle: explicit account replies and expected unknown/authenticated/unauthenticated states; expected outcomes are not obtained by asking the owner to compute them.
4. Stable seam: provider-auth normalization functions.
5. Refactor survival: assertions address that input/output contract rather than source identifiers, internal call order, CSS or module/export inventories.
6. Lowest distinct owner: cross-provider variants differ in native evidence; no other retained test enumerates these ambiguity cases.

## `apps/daemon/src/agent-host/adapters/fixture-redaction.test.ts`

Production owner read: `fixture-redaction.test.ts scanner plus fixture READMEs`. Non-test callers: committed protocol fixtures consumed by provider replay tests.

1. Independent source: AGENTS.md credential/private host-data exclusion and provider fixture README redaction policy.
2. Caller-visible failure: the particular missing/wrong response, persisted read, permission, state or content identified by each retained test title below.
3. Independent oracle: literal forbidden token/path patterns; complete captured Claude frames independently cross-check deltas; expected outcomes are not obtained by asking the owner to compute them.
4. Stable seam: committed bytes, decoded byte arrays and rejoined native streams.
5. Refactor survival: assertions address that input/output contract rather than source identifiers, internal call order, CSS or module/export inventories.
6. Lowest distinct owner: this is the only owner scanning fixture secrets across streamed boundaries; registry completeness ensures new sets cannot bypass it.

| Disposition | Original test / exact failure it detects | Reason / stronger remaining coverage |
|---|---|---|
| DELETE | allows only what the fixtures hold | An unused fake-value allowlist entry does not expose a secret or change runtime behavior; this only detects fixture inventory churn. All fixture-byte redaction scans remain. |

## `apps/daemon/src/agent-host/adapters/pending.test.ts`

Production owner read: `pending.ts; index.ts; provider pendingSnapshot builders`. Non-test callers: provider-snapshots registry/cache and launcher clients.

1. Independent source: §3.2 cold-host launchability and no pre-probe auth verdict; pending detection versus an actual missing-provider probe.
2. Caller-visible failure: the particular missing/wrong response, persisted read, permission, state or content identified by each retained test title below.
3. Independent oracle: explicit public snapshot fields, nonempty/default/unique model identities and real probe counterexamples; expected outcomes are not obtained by asking the owner to compute them.
4. Stable seam: ProviderSnapshot and isPendingSnapshot boundary.
5. Refactor survival: assertions address that input/output contract rather than source identifiers, internal call order, CSS or module/export inventories.
6. Lowest distinct owner: no other provider test jointly protects cold seeds before a CLI exists; probe results are a different state.

## `apps/daemon/src/agent-host/adapters/claude/classify.test.ts`

Production owner read: `claude/classify.ts`. Non-test callers: normalize.ts; project-history.ts; session approval routing.

1. Independent source: §4.2/4.3 canonical tool types and MCP-name substring regression.
2. Caller-visible failure: the particular missing/wrong response, persisted read, permission, state or content identified by each retained test title below.
3. Independent oracle: literal MCP/builtin names mapped to canonical API item/request enums; expected outcomes are not obtained by asking the owner to compute them.
4. Stable seam: tool-name to canonical protocol classification.
5. Refactor survival: assertions address that input/output contract rather than source identifiers, internal call order, CSS or module/export inventories.
6. Lowest distinct owner: retained fixtures exercise normal calls but not the conflicting MCP names or all builtin categories.

## `apps/daemon/src/agent-host/adapters/claude/config-dir.test.ts`

Production owner read: `claude/config-dir.ts`. Non-test callers: index.ts snapshots, session.ts skill discovery and goal transcript reader.

1. Independent source: §4.5 account-home selection and prior transcript/probe config-directory disagreement.
2. Caller-visible failure: the particular missing/wrong response, persisted read, permission, state or content identified by each retained test title below.
3. Independent oracle: explicit CLAUDE_CONFIG_DIR vs host homedir with conflicting child HOME; expected outcomes are not obtained by asking the owner to compute them.
4. Stable seam: shared account config path function.
5. Refactor survival: assertions address that input/output contract rather than source identifiers, internal call order, CSS or module/export inventories.
6. Lowest distinct owner: system-home skill lifecycle guards wiring; this owns precedence/managed-home cases across all readers.

## `apps/daemon/src/agent-host/adapters/claude/goal-transcript.test.ts`

Production owner read: `claude/goal-transcript.ts`. Non-test callers: ClaudeSession goal walks and resume reconcile.

1. Independent source: Goals §6.1.4/5 native transcript location and incremental durable read contract.
2. Caller-visible failure: the particular missing/wrong response, persisted read, permission, state or content identified by each retained test title below.
3. Independent oracle: real files with known ordered status rows, partial writes, replacement, symlink/prefix paths; expected outcomes are not obtained by asking the owner to compute them.
4. Stable seam: transcript reader filesystem operations and returned rows.
5. Refactor survival: assertions address that input/output contract rather than source identifiers, internal call order, CSS or module/export inventories.
6. Lowest distinct owner: lifecycle retains scheduling/order races, not this reader input matrix.

| Disposition | Original test / exact failure it detects | Reason / stronger remaining coverage |
|---|---|---|
| DELETE | reads a failed row | Only wraps parseGoalStatusRow with a file; failed parsing stays in goal.test and lifecycle delayed impossible-verdict case reads the real file to a failed event. |
| DELETE | an abandoned read never moves the position | Strict subset of a chunk that is abandoned loses nothing an earlier chunk committed, which checks both preservation of committed progress and rereading the abandoned chunk. |

## `apps/daemon/src/agent-host/adapters/claude/goal.test.ts`

Production owner read: `claude/goal.ts`. Non-test callers: ClaudeNormalizer and ClaudeGoalTranscript.

1. Independent source: Goals §3.1 and §6.1 observed Claude 2.1.280 command/hook/active_goal/goal_status formats; §6 progress suppression.
2. Caller-visible failure: the particular missing/wrong response, persisted read, permission, state or content identified by each retained test title below.
3. Independent oracle: quoted provider control text/rows and literal parsed goal outcomes; injected clock for distinct deferred-state edges; expected outcomes are not obtained by asking the owner to compute them.
4. Stable seam: native goal grammar parsers and smallest shared goal transition seam.
5. Refactor survival: assertions address that input/output contract rather than source identifiers, internal call order, CSS or module/export inventories.
6. Lowest distinct owner: normalizer keeps event routing; retained tracker edges cover stamped seeds and deferred cancellation/supersession not duplicated there.

| Disposition | Original test / exact failure it detects | Reason / stronger remaining coverage |
|---|---|---|
| DELETE | reads a replace, which prints exactly what a set prints | Identical Goal set grammar already exercised by reads a set; actual replacement of tracked goal is protected by normalize.goal event assertions. |
| DELETE | is seeded from knownGoal, so repeating it is not a change | Repeats the same-goal suppression contract protected by normalize.goal raw /goal and resume cases; private tracker decision shape adds no distinct failure. |
| DELETE | emits a real change with the whole goal | Private tracker emit/payload shape duplicates normalize.goal set event contract. |
| DELETE | always emits achieved, failed and cleared, with the goal that ended | Terminal goal payloads are covered individually by normalize.goal transcript met/failed/clear cases; this private decision-shape check adds no unique terminal case. |
| DELETE | throttles progress to one per 30 s and flushes the latest one when due | Private deferred decision objects duplicate normalize.goal deferred progress plus lifecycle real timer at 29,999/30,000 ms, which also proves dispatch. Remaining tracker tests retain cancellation and checked supersession edges. |

## `apps/daemon/src/agent-host/adapters/claude/history.test.ts`

Production owner read: `claude/history.ts; history-worker.ts`. Non-test callers: ClaudeSession readThread and rollback.

1. Independent source: §4.5 managed-home native history transport; documented pipe-buffer truncation regression.
2. Caller-visible failure: the particular missing/wrong response, persisted read, permission, state or content identified by each retained test title below.
3. Independent oracle: real SDK transcript file/OS pipe plus malformed/empty output fault at child-process boundary; expected outcomes are not obtained by asking the owner to compute them.
4. Stable seam: history reader process I/O.
5. Refactor survival: assertions address that input/output contract rather than source identifiers, internal call order, CSS or module/export inventories.
6. Lowest distinct owner: only suite proving shipped worker output survives OS pipe and reports both read/fork malformed payloads.

## `apps/daemon/src/agent-host/adapters/claude/launch.test.ts`

Production owner read: `claude/launch.ts; decisions.ts; models.ts`. Non-test callers: session start, probe and permission callbacks.

1. Independent source: §4.3/4.4/4.5 runtime modes, native SDK Options/PermissionResult; CLI model capability/version contract.
2. Caller-visible failure: the particular missing/wrong response, persisted read, permission, state or content identified by each retained test title below.
3. Independent oracle: explicit SDK option/reply values and invented capability/banner inputs; expected outcomes are not obtained by asking the owner to compute them.
4. Stable seam: native SDK wire/config builders.
5. Refactor survival: assertions address that input/output contract rather than source identifiers, internal call order, CSS or module/export inventories.
6. Lowest distinct owner: lifecycle retains stateful dispatch and security wiring; this owns full mode/model/decision/version matrix.

| Disposition | Original test / exact failure it detects | Reason / stronger remaining coverage |
|---|---|---|
| REWRITE | the default row is named after the model it resolves to | Keep launch alias and resolved model identity in the public descriptor; drop exact Default punctuation and duplicate shortName assertions because wording is not a contract. |
| DELETE | permissions come only from the runtime mode; effort only from the model selection | Repeats all three launch permission-mode cases plus supported effort and the supervised-start security regression. Those retained owners exercise the same mapping and exclusion of terminal permission flags. |

## `apps/daemon/src/agent-host/adapters/claude/lifecycle.test.ts`

Production owner read: `claude/index.ts; session.ts; deps.ts`. Non-test callers: host orchestration invokes AgentAdapter; real SDK Query is replaced at external dependency boundary.

1. Independent source: AgentAdapter §3.1/4.1/4.5 and goals §6.1 lifecycle; described crash, approval, rewind and async transcript regressions.
2. Caller-visible failure: the particular missing/wrong response, persisted read, permission, state or content identified by each retained test title below.
3. Independent oracle: scripted provider frames/receipts and real files, independently expected public events, cursors and SDK messages; expected outcomes are not obtained by asking the owner to compute them.
4. Stable seam: AgentAdapter operations/events and public SDK Query protocol.
5. Refactor survival: assertions address that input/output contract rather than source identifiers, internal call order, CSS or module/export inventories.
6. Lowest distinct owner: no lower pure parser can prove startup/teardown ordering, queued I/O, deadlines, child lifetime or dispatch routing; duplicate leaf mappings deleted.

| Disposition | Original test / exact failure it detects | Reason / stronger remaining coverage |
|---|---|---|
| DELETE | a path the text already names is not repeated, and an attachment-only turn is the block alone | Formatting edge cases are owned by shared attachment-lines tests; retained SDK non-image delivery and skill-dispatch attachment cases prove adapter integration and all attachment paths. |
| DELETE | acceptForSession rescopes the CLI's suggestion to the session | Duplicate of lower decision mapper test that checks every suggested permission destination; remaining callback accept case proves response plumbing and request identity. |
| DELETE | a session started from a cursor resumes instead of minting a session id | Covered by create-time cursor resume plus cursor refresh, lazy recovery, and full cursor read validation. This only rechecks query options for the same resume path. |
| DELETE | a session started fresh reads no transcript at all | The only distinctive assertion is private history-worker call count for an empty fresh session; empty projection and normal start/turn behaviors remain. |
| DELETE | a delta bigger than one read is walked chunk by chunk to its verdict | Strict subset of retained multi-chunk stop and simultaneous turn-end walk regressions that also assert the goal verdict and its turn/exit ordering. |
| DELETE | a teardown step that throws still ends the session: onClosed runs, nothing rejects, the thread recovers | Injects failure by monkey-patching ClaudeNormalizer.prototype.closeLiveTasks, a private collaborator shape; no stable external operation creates this invented failure. Real stream death, pending-request cancellation, file-read failure, and recovery/teardown races remain. |
| DELETE | the thread's goal that the transcript ended is `achieved` | Duplicate resumed transcript mapping: normalize.goal covers achieved/failed/cleared, real file transcript reader covers last row, and retained resumed restore plus slow-scan tests cover session wiring. |
| DELETE | the thread's goal with no goal_status row at all is `cleared` | Duplicate normalize.goal no-row clear contract and transcript readLast empty-goal result; retained resume restore case verifies session lookup. |
| DELETE | the same goal on both sides is quiet | Duplicate normalize.goal same-goal resume suppression and transcript reading; no extra lifecycle race or I/O condition. |

## `apps/daemon/src/agent-host/adapters/claude/normalize.goal.test.ts`

Production owner read: `claude/normalize.ts; goal.ts`. Non-test callers: ClaudeSession stream ingestion and transcript reconcile.

1. Independent source: Goals §6.1 canonical RuntimeEvent behavior from CLI goal frames/transcript outcomes.
2. Caller-visible failure: the particular missing/wrong response, persisted read, permission, state or content identified by each retained test title below.
3. Independent oracle: provider-shaped input and literal canonical goal changes/owner/phase outcomes; expected outcomes are not obtained by asking the owner to compute them.
4. Stable seam: provider frame to RuntimeEvent normalization.
5. Refactor survival: assertions address that input/output contract rather than source identifiers, internal call order, CSS or module/export inventories.
6. Lowest distinct owner: parser tests own grammar; these retained cases own runtime event attribution, suppression, epochs and terminal state.

| Disposition | Original test / exact failure it detects | Reason / stronger remaining coverage |
|---|---|---|
| DELETE | matches a condition the CLI cut to 500 characters | Duplicate truncation grammar owned by goal.test matching exact cut/marker and legacy cut forms; normalizer ordinary hook test retains checked-event integration. |
| DELETE | a compaction summary is still the marker's body, never a goal frame | Duplicates normalize.test boundary/summary ownership and real compact capture; text contains no goal control marker so it exercises no distinct goal branch. |
| DELETE | a phase change inside the throttle window is deferred, then flushed when due | Private callback/dueAt manual flush duplicate of lifecycle real 30-second timer scenario; lifecycle proves the flush actually gets scheduled and reaches runtime events. |

## `apps/daemon/src/agent-host/adapters/claude/normalize.test.ts`

Production owner read: `claude/normalize.ts; classify.ts; usage.ts`. Non-test callers: ClaudeSession stream reader, background shell tail and ingestion.

1. Independent source: §4.2/4.5/10 native Claude frames to RuntimeEvent; fixture README observations and locally documented reproduction traces.
2. Caller-visible failure: the particular missing/wrong response, persisted read, permission, state or content identified by each retained test title below.
3. Independent oracle: captured/native-shaped frames and explicit independent text, status, owner/turn and ordering outcomes; expected outcomes are not obtained by asking the owner to compute them.
4. Stable seam: provider frame to RuntimeEvent normalization.
5. Refactor survival: assertions address that input/output contract rather than source identifiers, internal call order, CSS or module/export inventories.
6. Lowest distinct owner: this is the owning protocol seam; deleted extra-layer ingestion replay, callback-harness assertions and output duplicates.

| Disposition | Original test / exact failure it detects | Reason / stronger remaining coverage |
|---|---|---|
| DELETE | `${fixture}: every captured message has a defined disposition` | Negative warning-only sweep can pass when every known message is discarded; observed is recorded by the harness, not production. Specific retained frame regressions assert actual output, and unknown-frame cases assert warnings positively. |
| DELETE | 03: an approval is opened and accepted | Replay harness chooses the route and supplies requestOpened/requestResolved fields itself. The lifecycle SDK callback case independently proves card identity, description, and approval reply. |
| DELETE | 04a/04b: decline and cancel are two answers, not two labels | The replay harness itself converts fixture denial sentences into decline/cancel before calling requestResolved, so expected behavior is implemented in the mock. The real decision mapper test retains both distinct denials. |
| DELETE | 05: accept-for-session prompts once across two turns | Card count is the count of captured callbacks; the mock chooses acceptForSession from fixture updatedPermissions. This cannot catch failure to grant session permission. Real SDK reply mapping remains tested. |
| DELETE | 06: AskUserQuestion becomes a question keyed by its text | Harness parses and calls question methods itself. Stable question parser and real adapter callback/response lifecycle cases retain exact text IDs, options and answers. |
| DELETE | 14a/14b: accept-edits and bypass produce no approval at all | Fixtures contain no canUseTool callback, so the harness cannot emit a card regardless of production runtime mode. Real SDK option mapping tests protect acceptEdits/bypass modes. |
| DELETE | through ingestion, the incident's turn is one message per text block, the answer last | Duplicates the same opening-turn message identity/order regression at an extra layer; retained normalizer cases assert exact text grouping, completion order and turn ownership at the owning seam. Generic ingestion joins are covered in ingestion. |
| DELETE | the latch does not survive the session: closeLiveTasks resets it | Exercises reuse of a normalizer after its session teardown, which production replaces; private reset state only. Live repeated compaction and lifecycle teardown contracts remain. |
| DELETE | emits a delta under the shell's own item and agent | Duplicate of real-file lifecycle tail case, which independently asserts exact appended bytes, item, agent, turn ordering and terminal drain. |
| REWRITE | a result with no assistant usage keeps the last known reading, never result.usage | Replace weak notEqual(rollup) with an established 4,100-token reading and exact retained reading whenever a row is emitted; arbitrary wrong readings must fail. |

## `apps/daemon/src/agent-host/adapters/claude/project-history.test.ts`

Production owner read: `claude/project-history.ts; rollback.ts`. Non-test callers: Claude adapter projectHistory and session readThread.

1. Independent source: §4.1/4.5 and E6 native-history replay; attachments and compaction must remain readable after resume.
2. Caller-visible failure: the particular missing/wrong response, persisted read, permission, state or content identified by each retained test title below.
3. Independent oracle: native transcript bodies and independently specified canonical text/status/turn ownership; expected outcomes are not obtained by asking the owner to compute them.
4. Stable seam: historical ThreadSnapshot to RuntimeEvent projection.
5. Refactor survival: assertions address that input/output contract rather than source identifiers, internal call order, CSS or module/export inventories.
6. Lowest distinct owner: live normalizer consumes another protocol/order and cannot protect historical-source routing; generic grouping duplicate deleted.

| Disposition | Original test / exact failure it detects | Reason / stronger remaining coverage |
|---|---|---|
| DELETE | reads both item shapes and skips anything else | Private readHistoryMessage wrapper shape; projection tests already consume bare message bodies, wrapped native rows in compaction/grouped history, and unprojectable system rows. Remove helper export. |
| DELETE | projects a grouped transcript end to end | Repeats simple grouping and turn/message projection; retained grouping case has tool-result/preamble distinctions and fixture/history cases assert content. |

## `apps/daemon/src/agent-host/adapters/claude/rollback.test.ts`

Production owner read: `claude/rollback.ts; cursor.ts`. Non-test callers: ClaudeSession rollback planning, readThread and persisted cursors.

1. Independent source: §4.1/4.5/5.5 resume storage compatibility and refuse-ambiguous rewind safety.
2. Caller-visible failure: the particular missing/wrong response, persisted read, permission, state or content identified by each retained test title below.
3. Independent oracle: independent transcript UUIDs/bodies and explicit retained cut/fork UUID outcomes plus malformed persisted records; expected outcomes are not obtained by asking the owner to compute them.
4. Stable seam: native rollback planner and persisted cursor codec.
5. Refactor survival: assertions address that input/output contract rather than source identifiers, internal call order, CSS or module/export inventories.
6. Lowest distinct owner: session tests retain actual fork/restart effects; this owns ambiguous/missing/compacted identity and tolerant migration matrices.

| Disposition | Original test / exact failure it detects | Reason / stronger remaining coverage |
|---|---|---|
| DELETE | indexes conversation messages, skipping system notices | Private filtered-index helper shape; retained remap tests include system notices and independently expect actual fork UUIDs. Remove helper export after checking callers. |
| DELETE | aligns from the truncated end, so a leading system notice is harmless | Exact duplicate of remaps onto the fork rewritten uuids: both prepend system-only rows, which are filtered before alignment. |

## `apps/daemon/src/agent-host/adapters/claude/skills.test.ts`

Production owner read: `claude/skills.ts; skill-dispatch.ts; questions.ts`. Non-test callers: Claude adapter snapshot/discovery and session input/approval callbacks.

1. Independent source: §4.6.2/4.6.4/4.6.8 native skill config/discovery/dispatch and §4.5 question text IDs.
2. Caller-visible failure: the particular missing/wrong response, persisted read, permission, state or content identified by each retained test title below.
3. Independent oracle: real SKILL.md/settings files, native YAML/JSON variants, prompt text and literal SDK questions/answers; expected outcomes are not obtained by asking the owner to compute them.
4. Stable seam: filesystem config discovery, config parsers and native dispatch/question codecs.
5. Refactor survival: assertions address that input/output contract rather than source identifiers, internal call order, CSS or module/export inventories.
6. Lowest distinct owner: lifecycle retains provider delivery; this owns configuration precedence, invalid siblings, token boundaries and question ambiguity.

| Disposition | Original test / exact failure it detects | Reason / stronger remaining coverage |
|---|---|---|
| DELETE | reports a missing frontmatter block as missing, not malformed | Private parser discriminant repeated by filesystem discovery: bare SKILL.md is retained and malformed frontmatter is excluded there. |
| DELETE | recognises a prompt that already opens with a slash command (§4.6.9) | Only caller of startsWithSlashCommand is this test. Claude sends slash-command text without consulting the helper; lifecycle attachment delivery protects actual /review dispatch. Remove the dead helper. |

## `apps/daemon/src/agent-host/adapters/claude/usage.test.ts`

Production owner read: `claude/usage.ts`. Non-test callers: ClaudeNormalizer; provider probe/snapshot.

1. Independent source: §4.1/4.2/4.5 native token accounting, subscription windows and authoritative /context fields.
2. Caller-visible failure: the particular missing/wrong response, persisted read, permission, state or content identified by each retained test title below.
3. Independent oracle: captured usage responses and explicit independently calculated counts/window states; expected outcomes are not obtained by asking the owner to compute them.
4. Stable seam: native usage payload to canonical usage codec.
5. Refactor survival: assertions address that input/output contract rather than source identifiers, internal call order, CSS or module/export inventories.
6. Lowest distinct owner: lifecycle retains refresh timing; normalizer retains ownership/dedupe; arithmetic and compatibility variants live here.

## Support/seam review before editing

- Remove `startsWithSlashCommand` entirely: repository search found only its own test as caller. Real slash dispatch never calls it.
- Make `parseSkillFrontmatter`, `readHistoryMessage`, and `conversationIndexForUuid` module-private after removing their direct tests; their remaining production callers are within their defining modules.
- Retain `ClaudeGoalTracker.lastEmitted`: unlike a test-only getter, `ClaudeSession.trackedGoal` reads it during recovery.
- Retain dependency factories and injected clocks used by surviving lifecycle/protocol tests: the real factory/session calls them, and tests replace only external SDK/process/time boundaries.
- Remove unused replay question handling and its answer decoder after removing the sole question capture; retain approval/plan paths used by 03/09.
- Make the unused fixture directory/type exports (`CLAUDE_FIXTURES_DIR`, `FixtureLine`, `ReplayResult`) module-private after verifying no outside import.
- Remove the replay inventory helper, observed-message tags and result field: only the deleted inventory sweep read them; smoke/replay consumers use events, clocks and IDs.
- Remove the lifecycle harness error-log collection: only the deleted prototype-monkeypatch case observed it.
- Remove the unused `ClaudeGoalTrackerOptions.throttleMs` override and field: no caller supplies an override; production always uses the specified 30-second interval.
- Remove the redaction scan cache: only the deleted allowlist-inventory case caused a second scan per provider. Every retained scan still checks all fixture bytes.
- Delete unneeded imports/support made dead by these dispositions.
- Remove raw Claude captures 04a, 04b, 05, 06 and 14b after checking every repository caller: their removed replay cases were their only behavioral consumers. Retain the README's observed protocol examples that independently specify the surviving permission/question tests, while updating its current file inventory. Fixture 14a stays because MCP output integration still replays it; 03 stays for parent ownership.

## Completed validation and review

- V passed: **429 tests, 84 suites; 0 failures, cancellations or skips**. This covers all shared and Claude adapter tests, including the lifecycle SDK boundary, actual transcript files, rollback, goal timing, permissions, attachments and fixture security.
- After removing the five unused captures and their replay-only support, ran `node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test --test-concurrency=2 apps/daemon/src/agent-host/adapters/fixture-redaction.test.ts apps/daemon/src/agent-host/adapters/claude/normalize.test.ts apps/daemon/src/agent-host/adapters/claude/project-history.test.ts`: **126 tests, 25 suites; 0 failures, cancellations or skips**.
- Compared the final TypeScript test AST with the recorded original inventory: 420 declarations remain, every KEEP remains, every DELETE is gone, and no empty describe block remains. Checked dead helper/export callers across the repository and reviewed the complete scoped diff.
- `git diff --check` passed for all scoped source, tests, captures and this report. Root workspace typecheck/test gates are reported in the repository cleanup summary.
- Production behavior is unchanged: removal of exports leaves internal callers intact, and the unused goal throttle override becomes the same specified constant all callers already used. No retained regression failed, and no coverage/count gate was changed. The main risk is accidentally deleting unique protocol behavior; the disposition rows identify the surviving owner for each deleted case.

Scoped tracked-file change: **-966 net LOC**; test files alone: **-620 net LOC**. The required audit report is accounted separately. Five unused raw captures were removed; all thirteen remaining captures have behavioral consumers.
