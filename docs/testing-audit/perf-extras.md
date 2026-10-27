# Incoming dry-run fixture correction

Baseline `ee5c3249` against `610d3c53`: `apps/box-agent/internal/agent/service_linux_test.go:60` / `TestServiceDryRunsWriteNothing`.

**REWRITE — existing declaration.** This row records a new body identity for an already-audited test; it adds no test and removes no declaration. Do not add it to prior new-test counts.

Integrate upstream non-root/system-unit portability fix while preserving the stronger current public dry-run artifact/privacy oracle. A non-root caller with an installed system unit must receive the existing authorization refusal; treating that legitimate refusal as an unconditional test failure is incorrect. Drop exact exception wording and arbitrary no-output/banner assertions.

The semantic merge retains the current actual-token/privacy/temporary-filesystem fixture. It also accepts the legitimate ownership refusal when the caller is non-root and an independently inspected system service path exists. The reason must identify the system-service ownership and sudo requirement; full prose, banner text and an incidental zero-output condition are omitted. Actual no-write/no-consumption checks remain in both allowed and refused states. No production behavior, timer, dependency or test hook changes.

## Six behavioral requirements

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 service ownership and CLI dry-run contract; AGENTS.md secrets stay host-only. Existing TestPlanUninstall deterministically owns non-root/system-unit denial.
- **Credible failure:** Dry run leaks or consumes a bootstrap token or writes service/user state; test wrongly rejects legitimate privilege denial on a non-root machine with a system service; wrong failure reason is not accepted.
- **Independent oracle:** Independently authored source-token marker and contents, temporary HOME/data directory absence/contents, literal public ORQ config keys/target paths. Privilege expectation comes from OS effective UID and stat of the independently specified /etc/systemd/system/orq-agent.service path, not a production helper/constant.
- **Stable seam:** Public InstallServiceCommand/UninstallServiceCommand with DryRun=true; caller-visible error reason and actual temporary filesystem/token artifacts.
- **Refactor resistance:** Use semantic system-service/sudo refusal markers rather than whole exception prose; permit informational output and avoid template formatting. Preserve cache/runner-independent actual artifact checks.
- **Unique protection:** The public dry-run owner uniquely verifies no side effects and no credential disclosure through real command wiring. Pure plan privilege tests do not verify real config/file handling; no duplicate leaf is added.

## Verification

- gofmt and scoped `git diff --check` passed.
- The assigned conflict path has no unmerged index stages and is staged for root integration.
- No tests ran while the root-owned matching incoming-reference baseline was active.

Pending target: `cd apps/box-agent && GO=/usr/local/go/bin/go node scripts/go.mjs test -race -run '^TestServiceDryRunsWriteNothing$' ./internal/agent`.

No added test declarations, subprocesses or real-time waits. No runtime improvement or comparison is claimed.
