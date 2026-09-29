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
| KEEP | appends an `Attached files:` block as a suffix, one `- name: path` line per attachment | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | is the block alone when the text is empty, so an attachment-only turn still says something | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | skips a path the text already names — the composer put it there (§7.4) — and returns the text by identity when nothing is left | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| DELETE | never prefixes or wraps: a leading slash command stays first (§4.6.9) | Duplicate suffix formatting assertion: the first format test fixes the appended position; Claude lifecycle sends a literal /review with an image and file and asserts the SDK text. No distinct bug is lost. |
| KEEP | collapses a run of control characters in a name to one space, so a name cannot forge a line of the turn | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | flattens C1 controls and Unicode line separators too, trims, caps a name at 255 and never leaves it empty | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | names an answer's file on one line, with its path or as not available (§6.2) | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | reads `namedIn` for a path already named, and still appends to `text` (§4.6.8) | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| REWRITE | removes one trailing block in the helper's own shape and nothing else | Replace setup through appendAttachmentPathLines with literal persisted prompt bytes. A writer and reader changing together must not make old native history unreadable. |
| KEEP | keeps a block that is the whole message: a replay has no attachment chips to show instead | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | returns text without a trailing block by identity, including a mid-text mention | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | answers in linear time when a block-shaped run fails at its last line | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| REWRITE | is true for exactly the block `appendAttachmentPathLines` writes onto empty prose | Use literal one/multiple-file persisted blocks instead of manufacturing accepted input with the companion writer; keep the colon-in-name edge. |
| KEEP | is false for anything around the block — leading blank lines, trailing prose — and for empty text | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |

## `apps/daemon/src/agent-host/adapters/auth-status.test.ts`

Production owner read: `claude/probe.ts; codex/probe.ts; opencode/snapshot.ts`. Non-test callers: provider snapshot builders and auth notice/workflow consumers.

1. Independent source: §7.7 ambiguity must not become a signed-out verdict, with documented false-sign-in regression.
2. Caller-visible failure: the particular missing/wrong response, persisted read, permission, state or content identified by each retained test title below.
3. Independent oracle: explicit account replies and expected unknown/authenticated/unauthenticated states; expected outcomes are not obtained by asking the owner to compute them.
4. Stable seam: provider-auth normalization functions.
5. Refactor survival: assertions address that input/output contract rather than source identifiers, internal call order, CSS or module/export inventories.
6. Lowest distinct owner: cross-provider variants differ in native evidence; no other retained test enumerates these ambiguity cases.

| Disposition | Original test / exact failure it detects | Reason / stronger remaining coverage |
|---|---|---|
| KEEP | is `unknown` when the probe itself failed | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | is `unknown` — never `unauthenticated` — when the init carried no account | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | keeps the api provider on the ambiguous verdict, for the card to label | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | is `authenticated` only once the init POSITIVELY yields credentials | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | is `unknown` when `account/read` could not be read at all | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | is `unauthenticated` ONLY when the CLI says an OpenAI login is required | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | is `authenticated` for every account shape it recognises | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | is `unknown` with nothing connected — there is no `opencode auth list` to ask | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | is `authenticated` as soon as one upstream is connected | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |

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
| KEEP | covers every fixture set | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | `${set}: no line, decoded byte array or joined stream holds a host-identifying value` | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| DELETE | allows only what the fixtures hold | An unused fake-value allowlist entry does not expose a secret or change runtime behavior; this only detects fixture inventory churn. All fixture-byte redaction scans remain. |
| KEEP | claude: every streamed block joins to what its complete frame holds | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |

## `apps/daemon/src/agent-host/adapters/pending.test.ts`

Production owner read: `pending.ts; index.ts; provider pendingSnapshot builders`. Non-test callers: provider-snapshots registry/cache and launcher clients.

1. Independent source: §3.2 cold-host launchability and no pre-probe auth verdict; pending detection versus an actual missing-provider probe.
2. Caller-visible failure: the particular missing/wrong response, persisted read, permission, state or content identified by each retained test title below.
3. Independent oracle: explicit public snapshot fields, nonempty/default/unique model identities and real probe counterexamples; expected outcomes are not obtained by asking the owner to compute them.
4. Stable seam: ProviderSnapshot and isPendingSnapshot boundary.
5. Refactor survival: assertions address that input/output contract rather than source identifiers, internal call order, CSS or module/export inventories.
6. Lowest distinct owner: no other provider test jointly protects cold seeds before a CLI exists; probe results are a different state.

| Disposition | Original test / exact failure it detects | Reason / stronger remaining coverage |
|---|---|---|
| KEEP | is synchronous and self-describing | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | claims no verdict: status unknown, auth unknown, the T3 message | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | Claude and Grok ship a bundled catalogue, so their launchers work on a cold host | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | Claude's pending catalogue names a default | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | every pending catalogue is free of duplicate slugs | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | isPendingSnapshot rejects a real probe result | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |

## `apps/daemon/src/agent-host/adapters/claude/classify.test.ts`

Production owner read: `claude/classify.ts`. Non-test callers: normalize.ts; project-history.ts; session approval routing.

1. Independent source: §4.2/4.3 canonical tool types and MCP-name substring regression.
2. Caller-visible failure: the particular missing/wrong response, persisted read, permission, state or content identified by each retained test title below.
3. Independent oracle: literal MCP/builtin names mapped to canonical API item/request enums; expected outcomes are not obtained by asking the owner to compute them.
4. Stable seam: tool-name to canonical protocol classification.
5. Refactor survival: assertions address that input/output contract rather than source identifiers, internal call order, CSS or module/export inventories.
6. Lowest distinct owner: retained fixtures exercise normal calls but not the conflicting MCP names or all builtin categories.

| Disposition | Original test / exact failure it detects | Reason / stronger remaining coverage |
|---|---|---|
| KEEP | an MCP tool is an MCP call whatever words its name holds | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | the built-in tools keep their buckets | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |

## `apps/daemon/src/agent-host/adapters/claude/config-dir.test.ts`

Production owner read: `claude/config-dir.ts`. Non-test callers: index.ts snapshots, session.ts skill discovery and goal transcript reader.

1. Independent source: §4.5 account-home selection and prior transcript/probe config-directory disagreement.
2. Caller-visible failure: the particular missing/wrong response, persisted read, permission, state or content identified by each retained test title below.
3. Independent oracle: explicit CLAUDE_CONFIG_DIR vs host homedir with conflicting child HOME; expected outcomes are not obtained by asking the owner to compute them.
4. Stable seam: shared account config path function.
5. Refactor survival: assertions address that input/output contract rather than source identifiers, internal call order, CSS or module/export inventories.
6. Lowest distinct owner: system-home skill lifecycle guards wiring; this owns precedence/managed-home cases across all readers.

| Disposition | Original test / exact failure it detects | Reason / stronger remaining coverage |
|---|---|---|
| KEEP | is the child env's CLAUDE_CONFIG_DIR — a managed account's home | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | falls back to the host user's ~/.claude, never to a HOME the env names | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |

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
| KEEP | names the project dir the way the CLI does | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | finds a transcript under the exact dir, and nothing that is not there | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | finds a long project path's dir by its prefix (its hash is the CLI's own) | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | falls back to the cwd's real path when the CLI resolved a symlink | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | reads only rows it has not read before | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| DELETE | reads a failed row | Only wraps parseGoalStatusRow with a file; failed parsing stays in goal.test and lifecycle delayed impossible-verdict case reads the real file to a failed event. |
| KEEP | leaves a line still being written for the next read | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | walks the file in bounded reads, rows split across reads included | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | skips a line longer than one whole read — a goal row never is | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | ignores rows that only mention goal_status | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | starts a goal set in this session at its set point, never at an older row | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | finds the LAST goal_status row and leaves the position at the end | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | anchors an unplaced position at the tail, never before an older run's rows | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | keeps a position the resume scan placed: rows written after the scan are read | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | reports a transcript with no goal rows as such | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | answers undefined, never throws, for a transcript that does not exist | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | follows a new session id to its own file, from its start | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | starts over when the file shrank under it | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | commits every chunk: a delta bigger than one read is walked in pieces, each one kept | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a chunk that is abandoned loses nothing an earlier chunk committed | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | says there is no more once only a line still being written is left | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
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
| KEEP | reads a set | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| DELETE | reads a replace, which prints exactly what a set prints | Identical Goal set grammar already exercised by reads a set; actual replacement of tracked goal is protected by normalize.goal event assertions. |
| KEEP | keeps a multi-line condition whole and ignores surrounding whitespace | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | reads a bare /goal that has not been evaluated yet | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | reads a bare /goal with rounds, singular and plural, and its last check | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | finds the status suffix behind a condition that has parentheses of its own | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | reads a clear, and both spellings of 'no goal' | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | reads both refusals, and any other text, as no goal change | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | takes the text from the content, falling back to the tagged local_command_source | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | matches the tracked goal's feedback and reads the evaluator's reason | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | does not claim another prompt hook's feedback | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | matches a condition the CLI cut to 500 characters, marker and all | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | finds the condition's end even when the condition itself contains ']: ' | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | ignores text that is not a Stop-hook feedback frame | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | reads the turn-end check-in and the idle one | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | reads the re-prompt after a turn that ended early as NOT waiting on background work | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | reads a value field-wise | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | drops a set_at outside the Date range instead of throwing | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | reads null (and a missing value) as 'no goal', and a malformed one as nothing | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | reads the set sentinel, a check, a met, an impossible and a clear | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | ignores every other row and drops malformed numbers | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | applies restoreGoalFromTranscript's rule: the LAST row decides | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| DELETE | is seeded from knownGoal, so repeating it is not a change | Repeats the same-goal suppression contract protected by normalize.goal raw /goal and resume cases; private tracker decision shape adds no distinct failure. |
| KEEP | drops a seeded goal's updatedAt: the fold's stamp is not provider state | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| DELETE | emits a real change with the whole goal | Private tracker emit/payload shape duplicates normalize.goal set event contract. |
| DELETE | always emits achieved, failed and cleared, with the goal that ended | Terminal goal payloads are covered individually by normalize.goal transcript met/failed/clear cases; this private decision-shape check adds no unique terminal case. |
| DELETE | throttles progress to one per 30 s and flushes the latest one when due | Private deferred decision objects duplicate normalize.goal deferred progress plus lifecycle real timer at 29,999/30,000 ms, which also proves dispatch. Remaining tracker tests retain cancellation and checked supersession edges. |
| KEEP | never throttles anything but progress, and a real change supersedes a deferred one | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a progress back to the emitted state cancels the deferred one | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |

## `apps/daemon/src/agent-host/adapters/claude/history.test.ts`

Production owner read: `claude/history.ts; history-worker.ts`. Non-test callers: ClaudeSession readThread and rollback.

1. Independent source: §4.5 managed-home native history transport; documented pipe-buffer truncation regression.
2. Caller-visible failure: the particular missing/wrong response, persisted read, permission, state or content identified by each retained test title below.
3. Independent oracle: real SDK transcript file/OS pipe plus malformed/empty output fault at child-process boundary; expected outcomes are not obtained by asking the owner to compute them.
4. Stable seam: history reader process I/O.
5. Refactor survival: assertions address that input/output contract rather than source identifiers, internal call order, CSS or module/export inventories.
6. Lowest distinct owner: only suite proving shipped worker output survives OS pipe and reports both read/fork malformed payloads.

| Disposition | Original test / exact failure it detects | Reason / stronger remaining coverage |
|---|---|---|
| KEEP | reads a transcript far larger than the pipe buffer | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a truncated payload is a named refusal, not a bare SyntaxError | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | names an empty payload rather than throwing 'Unexpected end of JSON input' | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | names unparsable output on the fork path too | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |

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
| KEEP | approval-required leaves permissionMode undefined so canUseTool is the gate | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | auto-accept-edits maps to acceptEdits | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | auto maps to auto | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | full access maps to bypassPermissions plus the dangerous flag | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | sets exactly what §4.5 prescribes | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | sends resume OR sessionId, never both | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | ultracode is xhigh effort PLUS the setting | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | gates a boolean option on the selected model's own capability | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | carries fastMode and thinking into settings where the model supports them | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| DELETE | permissions come only from the runtime mode; effort only from the model selection | Repeats all three launch permission-mode cases plus supported effort and the supervised-start security regression. Those retained owners exercise the same mapping and exclusion of terminal permission flags. |
| KEEP | the probe's options never run a hook and never open an MCP server | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | accept allows with the original input | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | acceptForSession allows and rescopes every suggestion to the session | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | acceptForSession falls back to a whole-tool session rule | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | acceptAlways denies — Claude has no permanent grant through canUseTool | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | decline and cancel are two answers, not two labels | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | only full-access short-circuits | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | reads the CLI version out of its banner | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | compares versions numerically, not lexically | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | refuses an unreadable version rather than passing it | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | builds effort descriptors from the CLI's own per-model levels | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | only offers boolean descriptors the model advertises | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | drops an effort level the selected model does not support | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | keeps the CLI's resolved id beside the launch alias | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |

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
| KEEP | refuses when the binary cannot be resolved | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | refuses a CLI below the minimum version, naming the version needed | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a spawn failure settles as an errored exit, not a hang | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | an expired handshake deadline kills the child instead of staying 'starting' | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | starts, runs a turn and settles it | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a non-image attachment reaches Claude as a path line in the final text block (§4.5) | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| DELETE | a path the text already names is not repeated, and an attachment-only turn is the block alone | Formatting edge cases are owned by shared attachment-lines tests; retained SDK non-image delivery and skill-dispatch attachment cases prove adapter integration and all attachment paths. |
| KEEP | a system-home thread finds its user-scope skills under the host user's ~/.claude | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | under a skill dispatch, a path typed after the `$skill` mention is not repeated (§4.6.8) | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | under a skill dispatch, the block rides the LEADING text and the command block stays last and untouched (§4.5) | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | steering reuses the active turn rather than opening a second one | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | plan mode is per turn and restores the session's base mode | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | refuses a promptless continuation — Claude does not declare the capability | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | compaction is the /compact turn and resolves when it settles | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | ingests inline only the images the API takes; everything else is a path line | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | puts the image blocks first and the path block inside the LAST text block | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | keys the card on the SDK's own request id and uses its description | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| DELETE | acceptForSession rescopes the CLI's suggestion to the session | Duplicate of lower decision mapper test that checks every suggested permission destination; remaining callback accept case proves response plumbing and request identity. |
| KEEP | a redelivered request does not open a second card | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a stop settles the open request as cancel BEFORE it closes the query | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | an interrupt settles the pending request before the interrupt RPC | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a non-empty interrupt receipt escalates to closing the query | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | an interrupt for a turn that is no longer active is a no-op | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | AskUserQuestion becomes a question and its answer rides back by text | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a stop settles an open approval once, withdrawn | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a stop settles an open question once, withdrawn | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | the CLI aborting a pending request withdraws it once | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | the user's own decision is never withdrawn | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a stream that ends mid-turn settles the turn and closes live tasks first | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | lazy recovery restarts from the persisted cursor | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| DELETE | a session started from a cursor resumes instead of minting a session id | Covered by create-time cursor resume plus cursor refresh, lazy recovery, and full cursor read validation. This only rechecks query options for the same resume path. |
| KEEP | the §6.1 create-time cursor resumes, and its first turn refreshes it | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a cursor that fails its shape check means no resume, never an error | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | the liveness watchdog cancels a silent turn and pauses on a pending request | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | forks the native session and restarts on the fork's id | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | rolling back every turn starts a fresh session rather than forking | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | refuses a misaligned fork rather than guessing | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | rejects a non-integer rewind | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | by id: keeps the turns before the target, resumes on the fork and closes the old peer | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | by id: a count that disagrees with the ids is logged, and the id decides | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | by id: a HISTORY turn of a resumed thread is rewindable, cut at its own anchor | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | by id: a turn one rewind kept is still rewindable by its own id after the fork | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | by id: a misaligned fork still refuses, and the live session is untouched | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | by id: an id the transcript cannot place refuses before any fork | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | probes without authenticating and publishes the §4.1 shape | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | degrades rather than throwing when the CLI is missing | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | marks a below-minimum CLI degraded and does not probe it | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | R6 #1: a session-scoped Stop with no running turn stops the background work | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | R6 #1: naming a turn that is not running is still a no-op | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | Q1 #12: an already-aborted host signal still stops everything | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | Q1 #13: a compaction that never settles is bounded, not a permanent wedge | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | Q1 #14: a rewind during a live turn keeps the right number of turns | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | Q1 #15 / R3 #5: a rewind across a compaction refuses BEFORE forking | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | Q1 #37: a redelivered question does not open a second card | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | R3 #8: an undeclared dialog kind is not answered at all | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | R2-1: the per-cwd overlay carries the machine command list | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | R3 #13: the probe runs under the account home when one is named | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | Q1 #35: two probes with different keys do not share one in-flight result | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | Q1 #38: a cursor naming another thread is rejected | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a supervised start launches supervised — no permission mode, no skip flag | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | reads the native transcript and projects it | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| DELETE | a session started fresh reads no transcript at all | The only distinctive assertion is private history-worker call count for an empty fresh session; empty projection and normal start/turn behaviors remain. |
| KEEP | an unreadable transcript degrades to an empty timeline, never an error | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | tails the CLI's output file and drains it BEFORE the completion bookend | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | an unreadable output file says so once and stops, rather than polling forever | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | reads the window once the session is ready, before any turn has run | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | refreshes after a result, attributing the row to the turn it was asked for | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a CLI that rejects the control request never fails the turn and never warns | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | an unanswered request expires on its own deadline rather than hanging the thread | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | an SDK with no getContextUsage at all degrades silently | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | declares the provider-command goal surface (goals §4.5) | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | reads the transcript after a result: a met goal is `achieved`, after the turn's own events | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a row of the goal's previous run, behind the set point, never ends the new run | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | still unmet with background work live at turn end is `waiting-background`; a throttled change is flushed by its timer | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a stop waits for a read in flight: the goal lands before session.exited | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a session dying with a goal read parked finishes its teardown before its recovery starts | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a stop on a session already closing waits for all of its teardown | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| DELETE | a delta bigger than one read is walked chunk by chunk to its verdict | Strict subset of retained multi-chunk stop and simultaneous turn-end walk regressions that also assert the goal verdict and its turn/exit ordering. |
| KEEP | a met verdict the CLI writes ~100 ms AFTER its result is found by the re-read, stamped with the turn that ended | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | an impossible verdict landing only by the second re-read is `failed` | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a new turn supersedes a pending re-read | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a walk whose epoch moved before it started ends WITHOUT reading: its rows stay for the next walk | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a read that fails ends its walk and hands off to the next waiting walk | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a stop mid-way through a multi-chunk walk still lands the verdict before session.exited | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | two turn-end walks never interleave: a verdict keeps the turn that wrote it | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| DELETE | a teardown step that throws still ends the session: onClosed runs, nothing rejects, the thread recovers | Injects failure by monkey-patching ClaudeNormalizer.prototype.closeLiveTasks, a private collaborator shape; no stable external operation creates this invented failure. Real stream death, pending-request cancellation, file-read failure, and recovery/teardown races remain. |
| KEEP | a session that ends drops the waiting phase — unthrottled, before session.exited | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a slow scan never resurrects a goal the user cleared meanwhile | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a goal the CLI re-arms but the thread lacks is `restored` | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| DELETE | the thread's goal that the transcript ended is `achieved` | Duplicate resumed transcript mapping: normalize.goal covers achieved/failed/cleared, real file transcript reader covers last row, and retained resumed restore plus slow-scan tests cover session wiring. |
| DELETE | the thread's goal with no goal_status row at all is `cleared` | Duplicate normalize.goal no-row clear contract and transcript readLast empty-goal result; retained resume restore case verifies session lookup. |
| DELETE | the same goal on both sides is quiet | Duplicate normalize.goal same-goal resume suppression and transcript reading; no extra lifecycle race or I/O condition. |
| KEEP | a missing transcript leaves the thread's goal alone, with a debug line | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a fresh session holds no goal: the thread's is `cleared` | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a lazy recovery compares with the goal the dead session last reported, not the one it started with | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |

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
| KEEP | completes a <synthetic> frame's text at the frame, not at the result | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | opens a turn for a <synthetic> frame that arrives between turns, and still completes it at once | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | leaves an ordinary snapshot-only frame as it was: its text still waits for the result | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a set emits `set` after the text, with the whole goal and the set time | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a set over a different running goal is `replaced`; the same goal again is no change | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a bare /goal reports rounds and the last check as progress on the tracked goal | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a bare /goal naming a goal nobody tracked is `restored` | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a clear is `cleared` with the goal that ended; 'No goal set' clears only a tracked goal | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | the refusals change nothing, and their text still renders | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | another local command's output is never read as a goal | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | falls back to local_command_source when the content carries no text | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | the tracked goal's feedback is `checked`, one round more, and never a user message | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| DELETE | matches a condition the CLI cut to 500 characters | Duplicate truncation grammar owned by goal.test matching exact cut/marker and legacy cut forms; normalizer ordinary hook test retains checked-event integration. |
| KEEP | another hook's feedback keeps today's behaviour: no goal change, no row | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | feedback with no tracked goal changes nothing | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a check-in is `progress` waiting on background work, and never a user message | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | the re-prompt after a turn that ended early is progress WITHOUT the waiting phase | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| DELETE | a compaction summary is still the marker's body, never a goal frame | Duplicates normalize.test boundary/summary ownership and real compact capture; text contains no goal control marker so it exercises no distinct goal branch. |
| KEEP | is recognised before the exhaustiveness switch, never a warning | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a value that moves nothing but the counters is progress, or nothing at all | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a value naming an untracked goal is `restored` | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | null asks the session for the transcript check, and emits nothing itself | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a malformed value is ignored, not warned about | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a met row is `achieved`, with the CLI's own totals on the goal that ended | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a failed row is `failed`, with the evaluator's reason | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a clear by an unrecoverable error — a met sentinel — is `cleared` | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | rows about another condition, and checks already seen on stdout, change nothing | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | still unmet with background work live at turn end is `waiting-background`, and back when it is not | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| DELETE | a phase change inside the throttle window is deferred, then flushed when due | Private callback/dueAt manual flush duplicate of lifecycle real 30-second timer scenario; lifecycle proves the flush actually gets scheduled and reaches runtime events. |
| KEEP | an `active_goal: null` re-read applies ended rows but never touches the phase | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a read asked for before the same goal was set again is moot | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | with no goal tracked, nothing is read into it | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a goal the CLI re-arms but the fold lacks is `restored` | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | any goal news off stdout makes a scan asked for before it moot: a clear is never resurrected | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | the same goal on both sides is no news | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a different goal in the transcript replaces the fold's | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | the fold's goal that the transcript ended is `achieved`, `failed` or `cleared` | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | the fold's goal with no goal_status at all is `cleared`; no goal on either side is nothing | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a session that ends takes its background work with it: the waiting phase is dropped at once | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a session that ends flushes a throttled progress rather than dropping it | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a new process has nothing in the background: a stale waiting phase is dropped | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |

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
| KEEP | 01: a plain text turn streams and settles | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | 02: an auto-allowed tool produces item rows and no approval | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| DELETE | 03: an approval is opened and accepted | Replay harness chooses the route and supplies requestOpened/requestResolved fields itself. The lifecycle SDK callback case independently proves card identity, description, and approval reply. |
| DELETE | 04a/04b: decline and cancel are two answers, not two labels | The replay harness itself converts fixture denial sentences into decline/cancel before calling requestResolved, so expected behavior is implemented in the mock. The real decision mapper test retains both distinct denials. |
| DELETE | 05: accept-for-session prompts once across two turns | Card count is the count of captured callbacks; the mock chooses acceptForSession from fixture updatedPermissions. This cannot catch failure to grant session permission. Real SDK reply mapping remains tested. |
| DELETE | 06: AskUserQuestion becomes a question keyed by its text | Harness parses and calls question methods itself. Stable question parser and real adapter callback/response lifecycle cases retain exact text IDs, options and answers. |
| KEEP | 07: a subagent and a background shell carry full linkage on every row | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | 07: the subagent's start carries the prompt its launch was given; the shell's carries none | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | 07: the subagent's Bash output carries its task; the parent's background launch carries none | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | 08: the step list is TaskCreate/TaskUpdate, not TodoWrite | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | 09: plan mode captures the plan and its planFilePath, then denies | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | 10: an interrupt settles the turn as interrupted without a diagnostic banner | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | 12: a compaction reports before/after and does not fail the turn | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| DELETE | 14a/14b: accept-edits and bypass produce no approval at all | Fixtures contain no canUseTool callback, so the harness cannot emit a card regardless of production runtime mode. Real SDK option mapping tests protect acceptEdits/bypass modes. |
| KEEP | 15: a warning-level rate_limit_event carries a percentage; a plain one does not | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | 16: an unknown model fails the turn with the CLI's own sentence | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | surfaces an unknown top-level message as a warning, never silently | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | surfaces an unknown system subtype as a warning | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | consumes the undeclared wire-only frames without a warning | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a warning never ends an active turn | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | system/init is idempotent state, not a per-turn event | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a model the adapter did not ask for is reported as a reroute | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | system/status is deduped rather than emitted three times per turn | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a user message whose content is a plain string does not throw | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | records the uuids a compaction preserved | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | prefers all_uuids, falls back to uuids, and stays undefined otherwise | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | turns a subagent's tool_use/tool_result and text into items owned by its task | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | holds its frames until a task carries the same description, then attributes them | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a resumed agent's start — same task, a new launching call — carries the resume's own prompt | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a start whose frame names no prompt takes the one its own launching Agent call carried | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a shell's start never carries a prompt, whatever its frame or its call named | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | matches the CLI's per-block assistant frame to its streamed block by order, not array index | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a second message whose text streams behind a thinking block again is a NEW item, not an append | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | holds without thinking too: two messages with text at index 0 are two items | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | an opening message that thinks first is ONE item, closed in place, and keeps its thinking | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | an opening message with no thinking is closed in place, not held back to `result` | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a user turn that opens mid-message adopts the message streaming so far | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a user turn that auto-closes a synthetic turn mid-message keeps that message's join | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a turn that begins while a synthetic turn is open settles that turn first, never overwrites it | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a woken message says the session is working at its message_start, before its turn exists | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a woken message that stops with no turn opening puts the session back to ready | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a held message keeps every delta, however long its first block streams | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a message that ended before any turn opened is never replayed into a later turn | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| DELETE | through ingestion, the incident's turn is one message per text block, the answer last | Duplicates the same opening-turn message identity/order regression at an extra layer; retained normalizer cases assert exact text grouping, completion order and turn ownership at the owning seam. Generic ingestion joins are covered in ingestion. |
| KEEP | opens the phase on the FIRST compacting status and never re-opens it | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a failed compaction ends the phase with the provider's own reason and warns | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a successful compaction adds nothing: the boundary already reports it | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a SECOND compaction later in the same session opens the phase again | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| DELETE | the latch does not survive the session: closeLiveTasks resets it | Exercises reuse of a normalizer after its session teardown, which production replaces; private reset state only. Live repeated compaction and lifecycle teardown contracts remain. |
| KEEP | is not surfaced at all: no task rows, no liveness, no shell item | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a later move to the background PROMOTES it: task.started, its shell item, then the update | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | surfaces the task and opens a command_execution item attributed to it | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | parses the output file out of the launch tool_result and asks the session to tail it | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | keeps a ~-abbreviated path verbatim — resolving it is the session's job | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| DELETE | emits a delta under the shell's own item and agent | Duplicate of real-file lifecycle tail case, which independently asserts exact appended bytes, item, agent, turn ordering and terminal drain. |
| KEEP | closes the item BEFORE the task row and carries the exit code on both | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a non-zero exit fails the item even when the notification says completed | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | an unknown exit code leaves the item's verdict to the notification | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | an ambient or skip_transcript task is never surfaced | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | closeLiveTasks fails the open shell item and stops its tail | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | never invents a terminal status for a task missing from the snapshot | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | still registers a task it names first, and leaves orphan notifications alone | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | does not retitle a task from its progress frames' live-activity description | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a subagent's task_progress usage never moves the thread meter | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a nested stream frame's message_delta usage never moves the thread meter | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| REWRITE | a result with no assistant usage keeps the last known reading, never result.usage | Replace weak notEqual(rollup) with an established 4,100-token reading and exact retained reading whenever a row is emitted; arbitrary wrong readings must fail. |
| KEEP | totalProcessedTokens is the cumulative modelUsage sum, not result.usage | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | folds an authoritative getContextUsage response through the same dedupe | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a result's nominal per-model window never overwrites the authoritative one | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | projects a nested thinking block as the agent's own reasoning row | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | keeps the agent's text and its thinking on separate items | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a nested stream_event never touches the parent's text block | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | holds the boundary until the synthetic summary that follows it | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | flushes the marker unchanged when the next frame is something else | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a synthetic frame that is not this boundary's anchor stays a normal frame | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | leaves the `<local-command-stdout>` replay frame exactly as it was | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | 12: the real capture's marker carries the real summary | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a nested Bash and a nested Write stamp their output with the owning task | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a frame held for its owner and a resumed agent's later frames both carry the owner | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a depth-2 agent's output carries the innermost agent, as the call's rows do | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a subagent's background launch: its placeholder carries the subagent, the shell's chunks the shell | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a CLI-denied subagent Bash carries its owner on the output and on the denial | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a denial for a call the adapter never saw still names the subagent that raised it | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | the parent's own output and approvals carry no owner | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a nested tool_result with no parent turn emits its output, stamped and turnless | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | the parent's result leaves the agent's call open; its own result lands whole, on the call's turn | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | neither does the auto-close of a stale synthetic turn | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | the owner's task_notification first closes its open calls, failed, each on its own turn | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a terminal task_updated closes them too, before its row | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a running status patch closes nothing | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | closeLiveTasks closes every call a subagent still has open, before the task rows | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a foreground agent's calls are still settled at the parent's turn end | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a foreground agent running inside a background one works on with it | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a parent call streamed before its synthetic turn opens is held with its message, and rides that turn from its start | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a parent call streamed before a USER turn opens in that window is held, and rides the user turn from its start | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a call streamed after its message's run ended rides that message's turn, closed at once — the next turn takes none of it | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a call a held message streams after that message was dropped with its run goes nowhere | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a call a message streams after the adapter itself settled its turn rides that turn and runs on there | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a call that already rides a turn stays on it when the next turn opens | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a subagent's tool_progress is its owner's heartbeat, on the call's own turn | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a tool_progress task_id counts only when it names a surfaced local_agent task | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a rejected window's parked-turn warning is a usage limit with its reset | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a window with no reset time names none | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | an allowed window says nothing | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a failed result after a rejected window is a usage limit, reset = the latest window | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a window that cleared no longer names the failure | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | an assistant frame flagged rate_limit makes the failed result a usage limit | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | authentication_failed, and a 401 or 403, are auth | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a rejected window BETWEEN parent turns (background agents working on) still raises the usage limit, with no turn | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a window that cleared between turns is not handed to the next turn | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | the recorded unknown-model failure names no account failure | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |

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
| KEEP | projects one turn.started/turn.completed pair per turn | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | stamps every event as historical, never as a live frame | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | carries the messages' text on item.completed rows | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | pairs a tool_use with its tool_result on one item keyed by the tool-use id | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | projects reasoning as a reasoning row plus a summary delta | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | carries the turn's model onto turn.started | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | closes a tool call whose result never arrived rather than leaving it live | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | renders a CLI denial as declined, not as a plain failure | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| DELETE | reads both item shapes and skips anything else | Private readHistoryMessage wrapper shape; projection tests already consume bare message bodies, wrapped native rows in compaction/grouped history, and unprojectable system rows. Remove helper export. |
| KEEP | survives a string `content`, which is what a compacted thread holds | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | replays a prompt without the `Attached files:` block the adapter appended to it | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | keeps the block of an attachment-only prompt, the turn's only evidence in a replay | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | shows the command block, not the block-only leading text, of a dispatch with attachments and no prose | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | keeps a block-only text block that is the message's only text when an image block sits beside it | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | projects nothing for a turn with nothing projectable | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | opens a turn at each human prompt and drops the preamble | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| DELETE | projects a grouped transcript end to end | Repeats simple grouping and turn/message projection; retained grouping case has tool-result/preamble distinctions and fixture/history cases assert content. |
| KEEP | replays it as the compaction marker, carrying the summary | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | never replays it as a user message the user never wrote | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |

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
| KEEP | counts only human prompts, never tool results or meta notices | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| DELETE | indexes conversation messages, skipping system notices | Private filtered-index helper shape; retained remap tests include system notices and independently expect actual fork UUIDs. Remove helper export after checking callers. |
| KEEP | keeps the turns before the removed one and anchors on the last kept entry | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | infers boundaries from history only when the turn counts agree | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | refuses when a boundary is missing from the history | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | refuses an empty history | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | returns no anchor when every turn is removed | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | remaps onto the fork's rewritten uuids | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | refuses when a retained body differs — role matching alone is not enough | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | refuses when the fork dropped a retained message | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| DELETE | aligns from the truncated end, so a leading system notice is harmless | Exact duplicate of remaps onto the fork rewritten uuids: both prepend system-only rows, which are filtered before alignment. |
| KEEP | a compaction makes an anchor outside the preserved set unreachable | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | with the transcript at hand, the last compaction summary's position decides | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | resolves a history turn no cursor recorded by identity — its id IS its uuid | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | resolves a turn whose uuid a fork rewrote through its recorded pair | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | refuses an id the history cannot place, rather than guessing | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | refuses a cut whose anchor a later compaction dropped | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a turn written after a live compaction rewinds although the list never named it | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | drops a pair whose uuid the transcript no longer holds, so its id is refused | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | orders recorded and identity boundaries by transcript index, not by record order | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | removing every turn yields no anchor: a fresh session, never a fork | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | refuses an empty history | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | round-trips | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | accepts the minimal {threadId, resume} the §6.1 resume picker builds | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | accepts every id the host's own resume rule accepts | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | rejects a cursor that names a different thread | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | rejects an unusable resume, without throwing | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | keeps a rollback anchor and normalises unknown boundaries to null | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | round-trips turnBoundaries next to the legacy list | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | a legacy cursor without turnBoundaries still reads, and pairs each uuid with itself | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | validates turnBoundaries field-wise, and never fails the cursor over them | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |

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
| KEEP | scans both roots, user first, and names a skill by its directory | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | reads the two inverse invocability flags, YAML-1.1 spellings included | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | honours skillOverrides from a lenient settings file | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | only offers enabled, user-invocable skills to the dispatcher | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | returns nothing rather than throwing for a missing config dir | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | lists the settings files in the CLI's precedence order | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | accepts the YAML 1.1 booleans the CLI accepts | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| DELETE | reports a missing frontmatter block as missing, not malformed | Private parser discriminant repeated by filesystem discovery: bare SKILL.md is retained and malformed frontmatter is excluded there. |
| KEEP | tolerates comments and trailing commas in a settings file | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | drops every override in a file when one entry is invalid, as the CLI does | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | rewrites the LAST known mention into a trailing /name block | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | opens the command block when the mention starts the prompt | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | rewrites earlier mentions inline so the model can still start them | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | leaves an unknown mention literal — a $HOME in prose is not a command | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| DELETE | recognises a prompt that already opens with a slash command (§4.6.9) | Only caller of startsWithSlashCommand is this test. Claude sends slash-command text without consulting the helper; lifecycle attachment delivery protects actual /review dispatch. Remove the dead helper. |
| KEEP | keys every question on its exact text | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | never trims or normalises the id | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | reports two questions with identical text rather than answering one | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | builds the reply shape the SDK looks up by text | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |

## `apps/daemon/src/agent-host/adapters/claude/usage.test.ts`

Production owner read: `claude/usage.ts`. Non-test callers: ClaudeNormalizer; provider probe/snapshot.

1. Independent source: §4.1/4.2/4.5 native token accounting, subscription windows and authoritative /context fields.
2. Caller-visible failure: the particular missing/wrong response, persisted read, permission, state or content identified by each retained test title below.
3. Independent oracle: captured usage responses and explicit independently calculated counts/window states; expected outcomes are not obtained by asking the owner to compute them.
4. Stable seam: native usage payload to canonical usage codec.
5. Refactor survival: assertions address that input/output contract rather than source identifiers, internal call order, CSS or module/export inventories.
6. Lowest distinct owner: lifecycle retains refresh timing; normalizer retains ownership/dedupe; arithmetic and compatibility variants live here.

| Disposition | Original test / exact failure it detects | Reason / stronger remaining coverage |
|---|---|---|
| KEEP | counts cache reads and writes as input | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | is partial when the turn did not end successfully | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | is unavailable when the turn produced none | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | reports reasoning tokens as a subset of output | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | prefers the last usage iteration for the live context reading | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | clamps the reading to the context window | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | reads the widest context window off the result's per-model map | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | turns a compaction boundary into before/after | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | normalises a task usage rollup or nothing at all | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | derives a total from input + output when none is stated | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | reads the captured response into §4.1's window shape | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | clears the bars for a login with no subscription windows | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | falls back to the legacy map when limits[] is absent | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | reads both account windows off CLI 2.1.280's unifiedWindows | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | maps a streamed event onto the row the probe drew, or onto nothing | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | recognises a blocking window and its recovery | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | derives the threshold from the buffer rows when the CLI reports none | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | carries no threshold and says so when auto-compaction is off | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | falls back to maxTokens when rawMaxTokens is missing, and keeps the known total | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | refuses a malformed or empty response rather than emitting a zeroed meter | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | reads the real captured payload of fixture 13 | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | sums every model's input, output and cache counts | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |
| KEEP | is undefined for a missing or empty map, so the caller can fall back | Retain this distinct contract/input condition under bars 1–6 above; failure changes the named public result. |

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
