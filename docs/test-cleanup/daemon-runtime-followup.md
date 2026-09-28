# Runtime seam follow-up

Pre-edit decisions, continuing the complete case audits in `daemon_runtime.md` and `adapter_claude_opencode.md`. This bounded follow-up changes test setup and removes test-only production parameters; no additional test scenarios are planned.

## REWRITE: usage HTTP transport setup

Paths: `apps/daemon/src/usage-claude-state.test.ts`, `usage-expiry.test.ts`, `usage-scoped.test.ts`, and `usage-sources.check.ts`.

All cases using `createClaudeSource`, `createCodexSource`, or `createGrokSource` with `fetchImpl` will use native `fetch` mocks instead. The original reports list every case and independent behavior. Distinct protected failures include reset windows remaining at 100%, lost live windows, repeated requests during Retry-After/backoff, lost last-good readings after restart, quota reads using the wrong account home, leaking auth bytes, missed rollout fallback, and expired credentials sent upstream.

Six-part retention bar: (1) OAuth/usage HTTP and account-home/security contracts plus the recorded reset/backoff regressions; (2) wrong/stale quota, wrong account, leaked token or blocked endpoint reaches callers; (3) literal incoming provider JSON, times, percentages, headers and expected refusals remain independent; (4) existing source functions are called by `index.ts` and the boundary becomes global HTTP transport; (5) changing private fetch storage or source implementation while preserving observable HTTP/results will not affect tests; (6) parsing-only and source-state contracts remain at their already-audited distinct owner, with no new duplicate cases. Non-test callers in `index.ts` pass no fetch override. Risk is low: production still captures global fetch at factory creation, exactly as its previous default did. Validation: the three focused node test files and standalone `usage-sources.check.ts` with daemon hooks.

## REWRITE: pinned source checksum rejection

Path: `apps/daemon/src/cliproxy-install.test.ts`, case `installBinary rejects a source checksum mismatch without installing`.

Remove the source SHA override and feed the existing deliberately invalid local tarball against the actual pinned default. Six-part bar: (1) pinned download integrity/security requirement; (2) corrupt/untrusted source must not install; (3) unrelated fixture bytes independently disagree with the pinned source digest; (4) public installer used by `index.ts`; (5) changed hashing/download internals still reject and leave no binary; (6) distinct patched-source path is not the release-binary integrity case. Non-test caller never overrides `sourceSha`. Risk low: fixed default unchanged. Validation: focused `cliproxy-install.test.ts`.

## REWRITE: OpenCode inventory process/retry contracts

Path: `apps/daemon/src/agent-host/adapters/opencode/cli-inventory.test.ts`. Cases:

- `the three probes run SEQUENTIALLY — concurrent runs hit one SQLite file`: preserve the no-overlap requirement through real fixture executables with native process start/close observation, removing private run-array assertions.
- `a non-zero exit is retried once, after a pause, still sequentially`: a fixture process fails the initial models command and then provides captured CLI output; preserve successful recovery plus the external command-attempt bound. Remove injected sleep and exact private sleep-call recording; the final case name states the recovery/attempt contract it asserts. A message port supplies the daemon lifecycle handle while the unchanged unreferenced production backoff timer runs.
- `agents and skills may each degrade to an empty list`: real fixture exits for optional inventories preserve usable authoritative models.
- `a models failure rejects — that one IS the catalogue`: a permanently failing authoritative model process rejects; exact error wording is not the contract.

Six-part retention bar: (1) agent-chat design §4.5 Catalogue fallbacks explicitly requires sequential probes, one retry and authoritative models; (2) overlap locks the shared provider DB, skipped retry loses the catalog, optional failure must not remove model choices, and authoritative failure must not look successful; (3) captured CLI records and fixture exit behavior are external inputs, with literal expected connected providers and failures; (4) `loadInventoryFromCli` is consumed by the OpenCode adapter; (5) internal command helper signatures, scheduler and parse organization may change without affecting executable results; (6) parser suites own malformed text, these four own external process orchestration and graceful failure. No production caller supplies `run` or `sleep`. Risk: fixture processes run only under temporary directories; no OpenCode or daemon service is started. Validation: focused CLI-inventory tests with standard hooks.

## Validation

Implemented cleanup. No tests were added or deleted in this follow-up; the original audited cases were rewritten at their stable external boundaries.

- From `apps/daemon`: `pnpm exec node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test src/usage-claude-state.test.ts src/usage-expiry.test.ts src/usage-scoped.test.ts src/cliproxy-install.test.ts src/agent-host/adapters/opencode/cli-inventory.test.ts`: 33 passed, 0 failed, 3 CLI cases cancelled when the default unreferenced retry timer outlived the standalone process's active handles. The harness now supplies a message-port lifecycle handle, as the daemon has active handles, without changing production timers.
- The same command restricted to `src/agent-host/adapters/opencode/cli-inventory.test.ts` then passed all 14 tests, zero failures/cancellations/skips. All 22 usage/installer cases passed in the first command and were not behaviorally changed afterward.
- `pnpm exec node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs src/usage-sources.check.ts`: `usage-sources.check OK`.
- Focused `git diff --check` passed; final changed source/test diffs reviewed. Root owns typecheck and complete repository gates.

Removed support: native-fetch factory overrides, patched-source digest override, CLI `run`/`sleep` overrides, now-unused CLI process helper/type exports, and the old fake-runner/sleep-recording harness. Production defaults and external behavior are unchanged.
