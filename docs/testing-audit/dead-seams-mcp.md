# Final MCP and secret-files dead-seam audit

Identity source: `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`. This is a bounded production-seam audit, not another test-case audit. **Zero test declarations are added or removed.** Four dead members are removed; two real production ports are retained. One existing case result-reader is adapted after the root focused run exposed its reference to the deleted fake slot; exact identity and evidence follow.

`SessionToolsHost.enabled` has no readers in any production adapter or test. Both implementations wrote `true`; Claude uses the host methods and Codex/Grok/OpenCode use the grant helper, whose optional-host check remains unchanged. Remove the inert interface member and both return fields.

`SecretFilesFileOps` and `GitRunner` have concrete non-test transport consumers: `boxAwareSecretFileIo` routes host/box file reads, writes and git operations; daemon startup wires it into `SecretFilesService`. Those ports remain. Only `parseEnv`, `compareContents` and `mergeEnvContents` override slots are removed: production never overrides them, and FakeFs merely repeated the real imports. The service now calls those same imported pure functions directly. No filesystem, git, watcher, clock, path-security or cancellation behavior changes.

Six source/helper/test files change by **−13 LOC**, including **−5 LOC of test infrastructure** and **+1 LOC in an existing test**. No test scenarios, fixtures, dependencies or configuration are removed. No runtime speedup is claimed.

## `apps/daemon/src/agent-host/session-tools/index.ts:149` — DELETE SessionToolsHost.enabled

- B1 — No independent enabled/disabled feature exists: real host and recording stub both set true; adapters gate on optional host presence, never this field.
- B2 — No user/caller-visible failure can be caught by a field with no reads; removing declarations changes no call, credential or manifest decision.
- B3 — Literal true written by both implementations is not an independent behavioral oracle.
- B4 — No public protocol or stable production consumer reads the field; it is an internal inert interface member.
- B5 — Keeping a test asserting the member would freeze dead shape; none exists.
- B6 — No unique regression protection. Real manifest/credential/cancellation tests remain unchanged.

Production caller evidence:

- No reads in repository production or tests. Only interface, real-return initializer and recording-return initializer.
- Claude createClaudeSessionToolsLaunch uses prepare/listSource/launchInProcess/call; Codex/Grok/OpenCode call issueSessionToolsGrant, which gates only context.sessionTools === undefined.

## `apps/daemon/src/secret-files/service.ts:126` — DELETE SecretFilesFileOps.parseEnv

- B1 — Pure implementation has a real independent content contract, but the injection slot itself has no requirement. Production host and box paths both always use the imported pure function.
- B2 — Preserve actual scan candidate env format/key count by calling the already imported function directly. Removing an unused override slot does not change default or fake behavior.
- B3 — No test supplies an alternative expected implementation: FakeFs.ops repeats the production function reference, so injected alias adds no oracle.
- B4 — Pure helper has its own stable content boundary; the service dependency object slot is unnecessary private plumbing.
- B5 — Direct calls survive service I/O-port reshaping; remove test-fake alias/import obligations.
- B6 — Existing pure files.ts tests and service integration retain all parser/compare/merge behavioral protection. No unique failure depends on the override slot.

Production caller evidence:

- All non-test calls use real imported function. boxAwareSecretFileIo overrides only readCloneFile/writeCloneFile/scanCandidates/trackedPaths.
- Only FakeFs.ops supplies the removed slot, as a direct alias to the same real function; repository search found no custom override.

## `apps/daemon/src/secret-files/service.ts:127` — DELETE SecretFilesFileOps.compareContents

- B1 — Pure implementation has a real independent content contract, but the injection slot itself has no requirement. Production host and box paths both always use the imported pure function.
- B2 — Preserve actual names-only compare response by calling the already imported function directly. Removing an unused override slot does not change default or fake behavior.
- B3 — No test supplies an alternative expected implementation: FakeFs.ops repeats the production function reference, so injected alias adds no oracle.
- B4 — Pure helper has its own stable content boundary; the service dependency object slot is unnecessary private plumbing.
- B5 — Direct calls survive service I/O-port reshaping; remove test-fake alias/import obligations.
- B6 — Existing pure files.ts tests and service integration retain all parser/compare/merge behavioral protection. No unique failure depends on the override slot.

Production caller evidence:

- All non-test calls use real imported function. boxAwareSecretFileIo overrides only readCloneFile/writeCloneFile/scanCandidates/trackedPaths.
- Only FakeFs.ops supplies the removed slot, as a direct alias to the same real function; repository search found no custom override.

## `apps/daemon/src/secret-files/service.ts:128` — DELETE SecretFilesFileOps.mergeEnvContents

- B1 — Pure implementation has a real independent content contract, but the injection slot itself has no requirement. Production host and box paths both always use the imported pure function.
- B2 — Preserve actual merge-source contents by calling the already imported function directly. Removing an unused override slot does not change default or fake behavior.
- B3 — No test supplies an alternative expected implementation: FakeFs.ops repeats the production function reference, so injected alias adds no oracle.
- B4 — Pure helper has its own stable content boundary; the service dependency object slot is unnecessary private plumbing.
- B5 — Direct calls survive service I/O-port reshaping; remove test-fake alias/import obligations.
- B6 — Existing pure files.ts tests and service integration retain all parser/compare/merge behavioral protection. No unique failure depends on the override slot.

Production caller evidence:

- All non-test calls use real imported function. boxAwareSecretFileIo overrides only readCloneFile/writeCloneFile/scanCandidates/trackedPaths.
- Only FakeFs.ops supplies the removed slot, as a direct alias to the same real function; repository search found no custom override.

## `apps/daemon/src/secret-files/service.ts:119` — KEEP SecretFilesFileOps external I/O port

- B1 — Secrets plugin must operate on host projects and box projects while preserving clone/path safety and tracked-file refusal.
- B2 — Removing this transport boundary would make box paths use host filesystem/git and violate actual caller-visible secret synchronization.
- B3 — Host/box transport behavior is independently specified; meaningful tests assert literal file state/refusals and cancellation rather than port declaration inventories.
- B4 — Four real clone I/O operations cross a production host/box boundary; not a test-only wrapper.
- B5 — Transport implementation can change behind these file/git operations while service contracts remain stable.
- B6 — Production box routing cannot be replaced by default host helpers. Existing real filesystem/git tests own I/O correctness and service tests own transactional sync.

Production caller evidence:

- apps/daemon/src/boxes/remote/fs/secret-files.ts:331 BoxAwareSecretFileIo and :342 boxAwareSecretFileIo implement the four-operation boundary.
- apps/daemon/src/index.ts:859 creates SecretFilesService and :888 spreads boxAwareSecretFileIo into its production options.

## `apps/daemon/src/secret-files/files.ts:32` — KEEP GitRunner / scanCandidates and trackedPaths injection

- B1 — Host and box repositories require the same ignored-candidate and literal-tracked-file protocols, with actual git execution on the correct machine and shutdown aborts.
- B2 — Hardwiring host git would scan the wrong filesystem for box projects; dropping abort/failure propagation could write tracked files or retain shutdown children.
- B3 — Existing tests use independent literal paths/errors/AbortError and real temp git repositories, not expected values computed from the implementation.
- B4 — A real command transport boundary: boxGitRunner executes through the connected box; defaultGitRunner uses host child process.
- B5 — Source identifiers and subprocess implementation may change without altering literal path/abort/error contracts.
- B6 — Non-test boxAwareSecretFileIo passes boxGitRunner into both functions; no single host-only runner can replace it. Underlying direct I/O tests and upper service tests protect distinct effects.

Production caller evidence:

- apps/daemon/src/boxes/remote/fs/secret-files.ts:264 boxGitRunner is production execution transport.
- Same module :371/:375 passes boxGitRunner or defaultGitRunner to scanCandidates/trackedPaths based on actual project location.
- apps/daemon/src/secret-files/service.ts DEFAULT_FILE_OPS also passes defaultGitRunner; abort signal is part of real shutdown behavior.

## Validation

All scoped diffs were reviewed and `git diff --check` passed. Repository searches verified no enabled reads and no pure-function overrides. Relevant provider adapter call sites and actual host/box secret-file wiring were inspected. No child tests, typechecks or timing runs were started because the root coordinator reserves the test slot. Required daemon typecheck, host/session-tools tests, secret-files files/service/integration/routes and box-aware secret-file tests remain pending central validation.

## `apps/daemon/src/secret-files/service.test.ts:249` — REWRITE

**setup: merge takes the union of keys, the primary's values winning; bad sources are refused**

Removed fake FileOps.parseEnv slot exposed one test result-reader dependency. Import the public real parser directly while preserving the independently authored expected key/value union and all service effects/refusals.

- B1 — Secret-files design setup/merge contract: primary values win; missing keys from eligible clones are included; tracked/refused/invalid clones never contribute; setup commits the chosen content and exclusion metadata.
- B2 — Setup must save A=1,B=2,C=3 from fixture primaryA=1/B=2 plus secondaryA=9/C=3, omit TRACKED=1, refuse bad source/configuration choices and report actual per-clone states. Detects incorrect source selection, primary precedence, dropped union keys or wrong committed vault content.
- B3 — Expected entries remain literal [[A,1],[B,2],[C,3]], independent from merge implementation. parseEnv only decodes actual persisted .env result via its public parser; it does not compute expected values.
- B4 — SecretFilesService.setup and actual saved vault bytes; parser import replaces private fake-dependency-object accessor.
- B5 — A future I/O-port reshape no longer breaks the result reader; it observes logical persisted keys, preserving behavior across harmless formatting changes.
- B6 — Pure merge/parser tests do not protect service source eligibility, primary selection, tracked exclusion, committed vault content and state metadata together; retained case owns that transactional integration.

The root focused run detected the removed fake parser accessor; this is a newly introduced test-fixture failure, now fixed. Root rerun is pending; no pass is claimed. Before SHA256: `693b8babecf3fe785f2635956af53f79f171fe2d31225de62d2ef648395e4b13`; after: `f59537cd516bae2cd3d4fc414bb9e9968fa9393a058c06832ef5232421249257`.
