# Workflow orphan-process timing followup

Baseline identity: `beb7516b10a3c4472399e0f6f2f2b0a187a61186`, `apps/daemon/src/workflows/sandbox/sandbox.test.ts:285`, `a runner killed outright reads as interrupted, and its work is ended`. This overrides that single KEEP row in workflows.md/workflows.json with OPTIMIZE; it adds no test declaration or runtime case. All earlier consolidations and the separate secret-marker fix remain accounted for in their original report. Additional test LOC: +12; production LOC: 0.

Implementation: wait for the actual supervisor to die after SIGKILL before enabling native setTimeout mocks. Start the real public runner wait, await the real recorded orphan process disappearing, then advance the documented 5,000 ms host escalation grace. That disappearance proves the TERM path executed and the grace timer was armed before advancing time. All interrupted/no-code/SIGKILL assertions remain. Exact pid/starttime guarded SIGKILL cleanup is registered for supervisor and child even when an assertion fails. The distinct SIGTERM-resistant escalation case still spends the real grace, so the suite retains actual signal-escalation coverage.

## Behavioral retention evidence

- **independentContract:** Workflow design §5.6/§5.8: an outright-killed detached supervisor with no exit record is interrupted, and its recorded process group is terminated safely.
- **realRegression:** A dead runner leaves its child running, or wait fabricates an ordinary success/exit code instead of an interrupted SIGKILL outcome.
- **independentOracle:** The fixture starts actual sleep work and kills the supervisor with OS SIGKILL. Literal interrupted=true, code=null, signal=SIGKILL and /proc pid/starttime liveness establish results independently. The documented 5,000 ms host grace is advanced only after real child termination.
- **stableSeam:** Public SandboxRunner.spawn/wait and OS process identity; native timer mocking controls the existing host Clock scheduling boundary. No result, process signal, filesystem receipt or child liveness is mocked.
- **refactorResistance:** No private call count, helper arrangement or timer inventory is asserted. The contract is observed through durable child identity, actual process death and public wait result; skipping an unnecessary grace after child death would also pass.
- **uniqueProtection:** The separate real-time SIGTERM-resistant case owns escalation after the actual 5 s grace. FakeSandbox/engine resume tests cannot prove cleanup of a real orphaned process after an unrecorded runner death. Neither is a substitute for this interrupted-record fixture.

## Measured results

| Measurement | Before | After repeat 1 | After repeat 2 |
| --- | ---: | ---: | ---: |
| Named case | 5060.966 ms | 48.924 ms | 56.927 ms |
| Complete filtered runner wall time | 6.04 s | 0.88 s | 1.00 s |

Using the two after observations, mean named-case saving is 5008.040 ms (98.95%). Mean filtered-runner wall saving is 5.10 s (84.44%). One before and two after observations use identical flags on the same Node v24.22.1 host with tsx disk caching disabled. These are focused observations; whole-suite and CI effects require the root measurements.

## Validation

From `apps/daemon`, the exact filtered command ran once before and twice after, all exit 0:

```sh
TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 '--test-name-pattern=a runner killed outright reads as interrupted, and its work is ended' src/workflows/sandbox/sandbox.test.ts
```

The same optimized case was then run with an isolated loader replacing the real orphan SIGTERM call with false. The loader confirmed its match. Expected and actual exit: 1. The case failed at the real liveness receipt with `Timed out waiting for the orphaned work to be gone`, proving timer control did not mock away orphan cleanup. The registered identity-guarded failure cleanup still executes. No source or live daemon was mutated by this regression probe.

```sh
ORQUESTER_AUDIT_MUTATION=orphan-term TSX_DISABLE_CACHE=1 node --import tsx --import /tmp/orquester-test-audit/workflows-mutate.mjs --test --test-timeout=600000 --test-concurrency=4 '--test-name-pattern=a runner killed outright reads as interrupted, and its work is ended' src/workflows/sandbox/sandbox.test.ts
```

`git diff --check -- apps/daemon/src/workflows/sandbox/sandbox.test.ts` passed. Final integrated typecheck and full-suite results belong to the root report.

Raw local evidence: `/tmp/orquester-test-audit/workflows-orphan-before.log`, `/tmp/orquester-test-audit/workflows-orphan-before.time`, `/tmp/orquester-test-audit/workflows-orphan-after-1.log`, `/tmp/orquester-test-audit/workflows-orphan-after-1.time`, `/tmp/orquester-test-audit/workflows-orphan-after-2.log`, `/tmp/orquester-test-audit/workflows-orphan-after-2.time`, `/tmp/orquester-test-audit/workflows-orphan-mutant.log`, `/tmp/orquester-test-audit/workflows-orphan-mutant.time`.
