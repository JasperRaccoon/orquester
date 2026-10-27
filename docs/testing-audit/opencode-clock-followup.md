# OpenCode native-clock follow-up

This follow-up supersedes the earlier statement in `adapters-claude-opencode.md` that the retry delay hook remains. The hook and its private delay-recording helper have now been removed. These are nine existing original `beb7516b` cases, not new tests or incoming-source additions. Match them by path and original name when replacing their earlier KEEP dispositions; do not add them to the inventory again.

The production adapter always calls the same `util.delay(ms, pumpAbort.signal)` implementation that production used before. The optional test-only override, test harness forwarding, and `recordedDelay` bookkeeping disappear. Native `setTimeout` mocks drive the actual abortable timers; `setImmediate` drains real promises and raw SSE delivery. The small test-local `advanceTo` helper advances time only while an existing public event/stream receipt is pending.

Changes: −7 production LOC, −17 test LOC, no test declarations added/deleted, no new production abstraction, fixture or dependency. Six existing cases are OPTIMIZE decisions; three ancestry cases are REWRITE decisions because private wait-call assertions are replaced by actual provider-query/card outcomes. There is no measured runtime-speedup claim for this follow-up.

## Validation

Applied only after root’s merge/edit release. `git apply --check` and the focused `git diff --check` passed. No tests ran while the root’s incoming-reference full suite was collecting uncontended measurements. After that reference finished, the root granted an exclusive test slot. From `apps/daemon`, executed:

```sh
TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=30000 src/agent-host/adapters/opencode/session.test.ts
TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=30000 --test-name-pattern='after a failed admission a relaunched child|a Stop whose abort request failed:|the end of a Stop whose abort request failed closes the children|a reconnect clears a stale busy|a reconnect keeps what a live run says|after a prompt admission fails and aborts the session|Q1 #21:' src/agent-host/adapters/opencode/session.test.ts
TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=30000 --test-name-pattern='after a failed admission a relaunched child|a Stop whose abort request failed:|the end of a Stop whose abort request failed closes the children|a reconnect clears a stale busy|a reconnect keeps what a live run says|after a prompt admission fails and aborts the session|Q1 #21:' src/agent-host/adapters/opencode/session.test.ts
```

The full file passed **111/111** cases. Both focused repeats passed **10/10** cases, including all nine native-clock cases and one related failed-Stop child-request case matched by the substring filter. No failures, cancellations or held-request deadline expirations occurred. Assertions and production/test code required no follow-up weakening or fixes.

Logs: `/tmp/orquester-test-audit/opencode-clock-full.log`, `opencode-clock-targeted-1.log` and `opencode-clock-targeted-2.log`. These diagnostic timings are not used for performance claims; the root may typecheck concurrently and owns the comparable full-suite measurements. Affected typechecks and the final repository gate remain centrally owned by root.

Native timers exercise the actual backoff’s abort behavior. The helper drains resolved fake HTTP work before advancing time and stops once its public receipt settles; the full run and repeated held-request scenarios confirmed that no unrelated HTTP deadline fired prematurely.

Potential mutation checks were not executed in this slot: remove the foreign-root early return (co-tenant GET count must increase); bypass the ancestry limit (capped GET count must exceed five); prevent closed-session fencing after backoff (stopped-session case must expose later provider work).

## Existing-case dispositions

### `apps/daemon/src/agent-host/adapters/opencode/session.test.ts:2533` — after a failed admission a relaunched child holds the drain, but reads interrupted: that session reads error, which the roster takes for dead

Disposition: **OPTIMIZE**, replacing the original KEEP record.

1. Independent contract: GUI design §§3.1,4.1/4.5; documented failed-admission transport doubt and background liveness exception.
2. Credible regression: Admission failure closes its launched child; a confirmed surviving child still blocks the drain while the transport-doubt fold reads interrupted.
3. Independent oracle: Fixed stopped task outcome, renewed launch identity, liveness="working", session status="error" and roster status="interrupted".
4. Stable seam: OpenCodeThreadSession public operations/status/events with raw SSE frames and recorded HTTP provider requests; nextStream and turn.completed receipts only drive virtual time.
5. Refactor resistance: Native timers run the unchanged production util.delay. No delay injection, private callback count, exact backoff duration, implementation constant, or internal identifier is asserted; boundary-preserving refactors preserve the oracles.
6. Unique protection: Owns admission failure followed by child survival, which pure task normalization and ordinary successful-turn child tests do not exercise.

### `apps/daemon/src/agent-host/adapters/opencode/session.test.ts:3284` — a Stop whose abort request failed: the stream's or the server's word that the run ended settles the turn as the abort would have — two idle frames or a lone one, before the failure or after it, or a reconnect's status poll; without that word, the next Stop asks the server again — and the next run is a new one

Disposition: **OPTIMIZE**, replacing the original KEEP record.

1. Independent contract: OpenCode fixture observations 5–7,11,29; GUI turn/interrupt ownership contract.
2. Credible regression: A failed abort may be confirmed by live idle or reconnect status; late abort echoes must not terminate the next independent run.
3. Independent oracle: Exactly the stopped turn gets turn.aborted once, no turn.completed for that stopped turn, ready session, and a subsequent woken/host turn retains its own expected identity/state.
4. Stable seam: OpenCodeThreadSession public operations/status/events with raw SSE frames and recorded HTTP provider requests; nextStream and turn.completed receipts only drive virtual time.
5. Refactor resistance: Native timers run the unchanged production util.delay. No delay injection, private callback count, exact backoff duration, implementation constant, or internal identifier is asserted; boundary-preserving refactors preserve the oracles.
6. Unique protection: Owns failed-abort confirmation across supported idle spellings and reconnect, plus separation from the following run. Successful Stop tests cannot detect these failed-abort state races.

### `apps/daemon/src/agent-host/adapters/opencode/session.test.ts:3493` — the end of a Stop whose abort request failed closes the children, then aborts them: a child's report in between asks the server only once that abort is over, so a child it ends is never relaunched — the run's idle or a reconnect's status poll

Disposition: **OPTIMIZE**, replacing the original KEEP record.

1. Independent contract: OpenCode fixture observation 29; background child/Stop ordering and liveness contracts.
2. Credible regression: A report received while the failed Stop’s eventual end aborts a child must wait for that abort and must not revive the now-dead child.
3. Independent oracle: A single stopped child, no status read while its abort is held, no relaunch or duplicate closing row after it completes, and liveness=null.
4. Stable seam: OpenCodeThreadSession public operations/status/events with raw SSE frames and recorded HTTP provider requests; nextStream and turn.completed receipts only drive virtual time.
5. Refactor resistance: Native timers run the unchanged production util.delay. No delay injection, private callback count, exact backoff duration, implementation constant, or internal identifier is asserted; boundary-preserving refactors preserve the oracles.
6. Unique protection: Owns deferred child judging during the abort triggered by eventual failed-Stop completion, including status recovered on reconnect. Ordinary interruption and native rule tests cannot establish that ordering.

### `apps/daemon/src/agent-host/adapters/opencode/session.test.ts:3675` — a reconnect clears a stale busy: a reply the host never started, after the gap, opens no turn

Disposition: **OPTIMIZE**, replacing the original KEEP record.

1. Independent contract: OpenCode busy/idle completion observations 5–7; no running state without current provider evidence.
2. Credible regression: A pre-gap busy frame must not create a phantom woken turn after the stream reconnects.
3. Independent oracle: No turn.started event; public session status="ready" and activeTurnId=undefined.
4. Stable seam: OpenCodeThreadSession public operations/status/events with raw SSE frames and recorded HTTP provider requests; nextStream and turn.completed receipts only drive virtual time.
5. Refactor resistance: Native timers run the unchanged production util.delay. No delay injection, private callback count, exact backoff duration, implementation constant, or internal identifier is asserted; boundary-preserving refactors preserve the oracles.
6. Unique protection: Owns removal of stale pre-reconnect run evidence. Positive wake tests cannot detect phantom turns after missed idle frames.

### `apps/daemon/src/agent-host/adapters/opencode/session.test.ts:3695` — a reconnect keeps what a live run says after it: a busy after the gap still opens the woken turn

Disposition: **OPTIMIZE**, replacing the original KEEP record.

1. Independent contract: OpenCode observed background-answer wake protocol and busy/idle completion observations 5–7.
2. Credible regression: Clearing stale pre-gap state must still admit a real busy/run observed after reconnect.
3. Independent oracle: Literal woken prompt identity FIRST.promptId and final state="completed", with the existing content/turn assertions retained.
4. Stable seam: OpenCodeThreadSession public operations/status/events with raw SSE frames and recorded HTTP provider requests; nextStream and turn.completed receipts only drive virtual time.
5. Refactor resistance: Native timers run the unchanged production util.delay. No delay injection, private callback count, exact backoff duration, implementation constant, or internal identifier is asserted; boundary-preserving refactors preserve the oracles.
6. Unique protection: Complements stale-busy rejection by detecting an over-broad reconnect reset that suppresses actual post-gap work; the negative case alone would pass that bug.

### `apps/daemon/src/agent-host/adapters/opencode/session.test.ts:3963` — after a prompt admission fails and aborts the session, a request is judged as after a Stop: the aborted run's is rejected, a live asker's shown

Disposition: **OPTIMIZE**, replacing the original KEEP record.

1. Independent contract: OpenCode prompt admission observation 14; lingering permission requests observations 11,29.
2. Credible regression: A failed prompt admission abort must reject the ended run’s late request while preserving a live requester’s actionable card.
3. Independent oracle: Failed completion and actual abort request; late permission reply={reply:"reject"}; only per_live appears as request.opened.
4. Stable seam: OpenCodeThreadSession public operations/status/events with raw SSE frames and recorded HTTP provider requests; nextStream and turn.completed receipts only drive virtual time.
5. Refactor resistance: Native timers run the unchanged production util.delay. No delay injection, private callback count, exact backoff duration, implementation constant, or internal identifier is asserted; boundary-preserving refactors preserve the oracles.
6. Unique protection: Owns request judging specifically after admission recovery exhausts, whereas ordinary user Stop and wire-only permission mapping cannot establish that state transition.

### `apps/daemon/src/agent-host/adapters/opencode/session.test.ts:4209` — Q1 #21: a co-tenant thread's ask is probed ONCE, not polled forever

Disposition: **REWRITE**, replacing the original KEEP record.

1. Independent contract: GUI design §3.2 one server per project; OpenCode fixture observation 19; historical Q1 #21 foreign-request polling regression.
2. Credible regression: A definitively foreign root must not be queried repeatedly or shown as this thread’s card.
3. Independent oracle: One actual GET /session/ses_cotenant after virtual time advances and no request.opened event. No assertion observes a delay callback.
4. Stable seam: OpenCodeThreadSession public operations/status/events with raw SSE frames and recorded HTTP provider requests; nextStream and turn.completed receipts only drive virtual time.
5. Refactor resistance: Native timers run the unchanged production util.delay. No delay injection, private callback count, exact backoff duration, implementation constant, or internal identifier is asserted; boundary-preserving refactors preserve the oracles.
6. Unique protection: The foreign-root definitive answer is distinct from transient unknown ancestry; retry-cap and cancellation cases alone do not prove co-tenant requests are discarded immediately.

### `apps/daemon/src/agent-host/adapters/opencode/session.test.ts:4237` — Q1 #21: an unreadable session is retried, but the chain is CAPPED

Disposition: **REWRITE**, replacing the original KEEP record.

1. Independent contract: Historical Q1 #21 unbounded ancestry-polling regression; terminal-event five-probe budget documented alongside the regression owner.
2. Credible regression: A transient ancestry lookup must retry but then stop rather than keep a permanent provider-poll chain alive.
3. Independent oracle: Five actual GET /session/ses_unreadable requests after ten scheduling opportunities, then still five after further advancement. No wait count or exact backoff duration is asserted.
4. Stable seam: OpenCodeThreadSession public operations/status/events with raw SSE frames and recorded HTTP provider requests; nextStream and turn.completed receipts only drive virtual time.
5. Refactor resistance: Native timers run the unchanged production util.delay. No delay injection, private callback count, exact backoff duration, implementation constant, or internal identifier is asserted; boundary-preserving refactors preserve the oracles.
6. Unique protection: Owns exhaustion of transient unknown ancestry. Foreign-root success and early session cancellation cannot detect an unbounded active retry chain.

### `apps/daemon/src/agent-host/adapters/opencode/session.test.ts:4262` — Q1 #21: closing the thread abandons an in-flight ancestry chain

Disposition: **REWRITE**, replacing the original KEEP record.

1. Independent contract: GUI design §3.1 closed-session/process ownership; Q1 #21 ancestry cleanup regression.
2. Credible regression: Stopping the session during a pending ancestry backoff must prevent later provider queries.
3. Independent oracle: One actual lookup before stop and still one after native timers advance following stop; no private delay/signal-call recording.
4. Stable seam: OpenCodeThreadSession public operations/status/events with raw SSE frames and recorded HTTP provider requests; nextStream and turn.completed receipts only drive virtual time.
5. Refactor resistance: Native timers run the unchanged production util.delay. No delay injection, private callback count, exact backoff duration, implementation constant, or internal identifier is asserted; boundary-preserving refactors preserve the oracles.
6. Unique protection: Owns cancellation before retry exhaustion. A finite-cap test can pass while a closed session continues querying up to that cap.
