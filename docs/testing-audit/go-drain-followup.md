# Go drain regression: remove private test hooks

Baseline identity: `apps/box-agent/internal/agent/exec_unix_test.go` / `TestExecOutputTailSurvivesADaemonSlowerThanTheDrainDeadline` from `beb7516b`.

**Accounting:** this supersedes that existing KEEP row in `extras.json`; change KEEP−1 / REWRITE+1. It adds no test/declaration and must not be counted twice. The earlier extras report statement that a hook was necessary is superseded by this stable-seam rewrite.

**Implemented:** remove `drainPausedHook` and its branch; make the unchanged two-second read-drain budget a private constant. No production timer behavior changes, dependencies or Go minimum changes.

The child fills the output window except one byte, then waits for stdin. A two-byte `xy` write spends the last byte of credit on `x`, publicly proving the pump is blocked on `y`. Only then does another stdin message allow a separate 4096-byte tail and process exit. Existing OS condition-based synchronization confirms the child has exited. Credit remains withheld for a real five-second observation window: premature EOF/exit/close fails. Restoring credit must deliver exactly `y` plus 4096 zero bytes before successful exit/close.

This retains the unique regression while observing actual protocol and process outcomes. The real elapsed window is necessary because Go 1.24 has no suitable virtual-time seam for this IO and the application deadline has no public completion receipt. It is an exercised timeout/backpressure scenario, not a startup sleep. Its cost is explicitly retained; no measured performance delta is claimed.

## Six behavioral requirements

- **Independent contract:** packages/api/src/box-protocol.ts channel credit/backpressure and byte-stream ordering; AGENTS.md preserve streaming and process lifecycle. Child output already produced must be delivered before EOF/exit/close even if the daemon consumes slowly.
- **Real regression:** A drain that counts time waiting for credit closes output prematurely, losing an unread tail and/or emitting EOF/exit/close before pending bytes reach the daemon.
- **Independent oracle:** Authored shell output: window−1 zero bytes, atomic xy marker, separate 4096 zero-byte tail. The test independently expects last credited x, pending y+4096 zeros, exact total byte count and exit 0/close.
- **Stable seam:** Actual exec channel stdin/credit/data/EOF/exit/close frames and observed OS process exit. No outputPumps callback, state accessor or timeout override remains.
- **Refactor resistance:** Pump/helper/variable identifiers and scheduling strategy may change. Only public wire credit/output and actual process lifetime are observed. A real five-second hold exercises the deployed deadline rather than replacing it.
- **Unique protection:** Only retained non-detached exec case guarantees both a credit-blocked write and unread output after child exit. Ring overflow/reattach, ordinary exec, and detached viewer tests protect different states.

## Verification

- gofmt, scoped `git diff --check`, and the search for removed hook references passed.
- From `apps/box-agent`: `GO=/usr/local/go/bin/go node scripts/go.mjs test -race -count=2 -run '^TestExecOutputTailSurvivesADaemonSlowerThanTheDrainDeadline$' -v ./internal/agent` — passed twice (5.06s and 5.04s; command wall 12.66s).
- From an isolated temporary copy of `apps/box-agent`: `GO=/usr/local/go/bin/go node scripts/go.mjs test -race -count=1 -run '^TestExecOutputTailSurvivesADaemonSlowerThanTheDrainDeadline$' -v ./internal/agent` — intentionally failed at 4.04s (command wall 6.07s) after the old wall-time drain behavior was restored in that copy. The failure was `the channel ended before its output was delivered: map[ch:1 stream:1 t:eof]`.
- SHA-256 checks confirmed both shared source files remained exactly unchanged by the mutation run; they were never mutated and required no restoration.

The mutant makes `waitFor` return false on timer expiry despite a credit-blocked write. Its premature EOF demonstrates that the retained public-seam test still detects the historical output-loss failure. No comparable pre-rewrite individual runtime exists, and no suite speedup is claimed. Root owns the broader package/integration/full gates.
