# Workflow execution cleanup

Recorded before edits. Scope: the 15 paths in `/tmp/orquester-test-cleanup/workflow_execution.txt`.

Independent source: `docs/superpowers/specs/2026-09-28-automated-workflows-design.md`, cross-checked against current transport/config contracts and source (the spec has older implementation details, so literal source inventories are not retained). Root full baseline `pnpm test` passed.

For each retained isolated owner, its failure modes are listed by the named scenarios below: wrong returned value/identity, wrong accepted/rejected state, lost durable data, duplicate side effect, leaked secret, blocked loop, or leaked child process. Each row is the exact original test name; parameter families are expanded separately.

## `apps/daemon/src/workflows/agent/cooldowns.test.ts`

Independent contract (bar 1): §5.4 shared persisted cooldowns and auth/reset precedence. Visible failure (bar 2): the scenario named in each retained row produces wrong caller-visible data/state, persistence, command, or process outcome. Independent oracle (bar 3): fixed input/output values and errors from that contract; rewrite rows below remove computed oracles. Stable seam (bar 4): createCooldownStore and cooldownUntil. Refactor tolerance (bar 5): assert results of that seam, no source spelling, helper inventory, classes or private call count. Ownership (bar 6): failover tests use a memory cooldown double, so only this real state-store boundary verifies persisted keys and expiry; numeric boundary cases do not replay whole failover. Non-test callers: failover.ts and daemon-wiring.ts.

Risk: low for removal of duplicate/private assertions; protocol/storage/security edge cases remain. Validation: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test <retained assigned paths>` from `apps/daemon`, then root `pnpm check` / `pnpm test`.

| Disposition | Original case | Reason / detected failure |
| --- | --- | --- |
| REWRITE | `the cooldown store keys <family>:<accountId>, serves only active ones and prunes expired on write` | Keep externally persisted keys, expiry and family isolation; remove private write-count/timing expectation. |
| KEEP | `cooldownUntil: resetsAt, else the burnt window's reset, else an hour; auth always an hour` | Protects the distinct failure specified by this case: cooldownUntil: resetsAt, else the burnt window's reset, else an hour; auth always an hour. No equivalent scenario at another retained owner covers this input transition. |
| DELETE | `buildCooldown makes the persisted record` | Private record-builder shape duplicate; persisted cooldown store and actual failover cooldown assertions own the storage contract. |
| KEEP | `cooldownUntil: a limit with no known reset escalates per strike (1 h, 2 h, 4 h at most); a known reset never does` | Protects the distinct failure specified by this case: cooldownUntil: a limit with no known reset escalates per strike (1 h, 2 h, 4 h at most); a known reset never does. No equivalent scenario at another retained owner covers this input transition. |

## `apps/daemon/src/workflows/agent/executor.test.ts`

Independent contract (bar 1): §5.1–§5.5 agent block protocol and held-wake regression described in watch.ts. Visible failure (bar 2): the scenario named in each retained row produces wrong caller-visible data/state, persistence, command, or process outcome. Independent oracle (bar 3): fixed input/output values and errors from that contract; rewrite rows below remove computed oracles. Stable seam (bar 4): createAgentExecutor.execute(NodeExecutionContext). Refactor tolerance (bar 5): assert results of that seam, no source spelling, helper inventory, classes or private call count. Ownership (bar 6): fake host supplies external protocol replies; actual executor chooses commands, request ids, waiting state and output. Selection algorithm edge matrix stays in select.test.ts. Non-test callers: daemon-wiring.ts registers executor for workflow engine.

Risk: low for removal of duplicate/private assertions; protocol/storage/security edge cases remain. Validation: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test <retained assigned paths>` from `apps/daemon`, then root `pnpm check` / `pnpm test`.

| Disposition | Original case | Reason / detected failure |
| --- | --- | --- |
| REWRITE | `happy path: creates the session like the MCP, sends the prompt with the autonomy note, returns the last message` | Use an independent literal from workflow spec §5.1 for the transmitted autonomy note and remove title-only copy assertion. |
| KEEP | `continue-session mode: a follow-up turn into the upstream block's session; its text only` | Protects the distinct failure specified by this case: continue-session mode: a follow-up turn into the upstream block's session; its text only. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `continue-session mode without an upstream session fails as a validation error` | Protects the distinct failure specified by this case: continue-session mode without an upstream session fails as a validation error. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `a saved prompt + append renders {{…}} first, escaped for the {variables} pass, then the variables` | Protects the distinct failure specified by this case: a saved prompt + append renders {{…}} first, escaped for the {variables} pass, then the variables. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `a failed variable read fails the block naming it, and no session is created` | Protects the distinct failure specified by this case: a failed variable read fails the block naming it, and no session is created. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `a missing saved prompt fails the block` | Protects the distinct failure specified by this case: a missing saved prompt fails the block. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `questions are answered autonomously: custom text where allowed, else (Recommended), else the first option — message-mode too, never dismissed` | Protects the distinct failure specified by this case: questions are answered autonomously: custom text where allowed, else (Recommended), else the first option — message-mode too, never dismissed. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `an approval is accepted` | Protects the distinct failure specified by this case: an approval is accepted. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `a plan card is implemented with the plan implementation prompt` | Protects the distinct failure specified by this case: a plan card is implemented with the plan implementation prompt. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `done only after background work ends (then the quiet window)` | Protects the distinct failure specified by this case: done only after background work ends (then the quiet window). No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `whenOnlyWatchLoopsRemain: finish ends after a 60 s grace; wait keeps waiting until maxMinutes` | Protects the distinct failure specified by this case: whenOnlyWatchLoopsRemain: finish ends after a 60 s grace; wait keeps waiting until maxMinutes. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `a background agent waking the parent into a provider-started turn is waited for; its text is the output` | Protects the distinct failure specified by this case: a background agent waking the parent into a provider-started turn is waited for; its text is the output. No equivalent scenario at another retained owner covers this input transition. |
| REWRITE | `a wake that becomes a turn only 20 s after the background work ended is still waited for (a held Claude wake)` | Keep the delayed-wake regression; delete the second execution that deliberately injects obsolete timings and asserts the old bug. |
| KEEP | `background work that ended with no wake finishes after the 90 s wake window` | Protects the distinct failure specified by this case: background work that ended with no wake finishes after the 90 s wake window. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `a quiet window catches a wake that comes right after the turn settles` | Protects the distinct failure specified by this case: a quiet window catches a wake that comes right after the turn settles. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `maxMinutes interrupts the agent and fails the block with timeout` | Protects the distinct failure specified by this case: maxMinutes interrupts the agent and fails the block with timeout. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `the run's cancel interrupts the agent and ends the block cancelled` | Protects the distinct failure specified by this case: the run's cancel interrupts the agent and ends the block cancelled. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `a failed turn without a limit/auth reason is an agent_error with the host's message` | Protects the distinct failure specified by this case: a failed turn without a limit/auth reason is an agent_error with the host's message. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `the live fields: selection, sessionId, hops and a throttled activity line` | Protects the distinct failure specified by this case: the live fields: selection, sessionId, hops and a throttled activity line. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `a host that is restarting (503 on create) is retried on the clock; one session results` | Protects the distinct failure specified by this case: a host that is restarting (503 on create) is retried on the clock; one session results. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `a continue block never implements a plan an earlier block left behind` | Protects the distinct failure specified by this case: a continue block never implements a plan an earlier block left behind. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `an account the daemon would not launch (not seeded for claudemix) is passed over by the catalogue check, never sent` | Protects the distinct failure specified by this case: an account the daemon would not launch (not seeded for claudemix) is passed over by the catalogue check, never sent. No equivalent scenario at another retained owner covers this input transition. |

## `apps/daemon/src/workflows/agent/failover.test.ts`

Independent contract (bar 1): §5.4 eligible-account failover, cooldown isolation, twelve-hop cap and reset behavior. Visible failure (bar 2): the scenario named in each retained row produces wrong caller-visible data/state, persistence, command, or process outcome. Independent oracle (bar 3): fixed input/output values and errors from that contract; rewrite rows below remove computed oracles. Stable seam (bar 4): createAgentExecutor.execute plus quota owner coolDown. Refactor tolerance (bar 5): assert results of that seam, no source spelling, helper inventory, classes or private call count. Ownership (bar 6): distinct provider limit timing, refusal, quota and reset scenarios; duplicate hop counter and two-account matrix removed. Non-test callers: daemon-wiring.ts / executor.ts.

Risk: low for removal of duplicate/private assertions; protocol/storage/security edge cases remain. Validation: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test <retained assigned paths>` from `apps/daemon`, then root `pnpm check` / `pnpm test`.

| Disposition | Original case | Reason / detected failure |
| --- | --- | --- |
| KEEP | `limit at create (the provider never starts): switch account in the same session` | Protects the distinct failure specified by this case: limit at create (the provider never starts): switch account in the same session. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `limit at turn start: switch account` | Protects the distinct failure specified by this case: limit at turn start: switch account. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `limit mid-turn: the partial work stays in the session and the new account continues it` | Protects the distinct failure specified by this case: limit mid-turn: the partial work stays in the session and the new account continues it. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `limit while parked (Claude's warning, turn still running): cooled until resetsAt, interrupted, switched` | Protects the distinct failure specified by this case: limit while parked (Claude's warning, turn still running): cooled until resetsAt, interrupted, switched. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `a legacy limit row (no reason field, only the adapter's prefix) still fails over` | Protects the distinct failure specified by this case: a legacy limit row (no reason field, only the adapter's prefix) still fails over. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `limit during background work: the whole thread is interrupted, then switched` | Protects the distinct failure specified by this case: limit during background work: the whole thread is interrupted, then switched. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `a switch refused once (something still in flight) waits for idle again, then switches` | Protects the distinct failure specified by this case: a switch refused once (something still in flight) waits for idle again, then switches. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `a switch the host keeps refusing hands off to a NEW session on the same agent's next account` | Protects the distinct failure specified by this case: a switch the host keeps refusing hands off to a NEW session on the same agent's next account. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `cross-family handoff: a new session with the handoff prompt (original prompt, notice, last messages, git status)` | Protects the distinct failure specified by this case: cross-family handoff: a new session with the handoff prompt (original prompt, notice, last messages, git status). No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `an auth handoff says the login failed and never passes the provider's error text as the agent's messages` | Protects the distinct failure specified by this case: an auth handoff says the login failed and never passes the provider's error text as the agent's messages. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `a same-family switch after a refused login says so, not 'usage limit'` | Protects the distinct failure specified by this case: a same-family switch after a refused login says so, not 'usage limit'. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `the handoff caps the previous messages at 32 KiB (newest kept) and git status at 8 KiB` | Protects the distinct failure specified by this case: the handoff caps the previous messages at 32 KiB (newest kept) and git status at 8 KiB. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `OpenCode has no accounts: a limit goes to the next chain entry` | Protects the distinct failure specified by this case: OpenCode has no accounts: a limit goes to the next chain entry. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `chain exhausted: fails all_burnt with every hop and skip` | Protects the distinct failure specified by this case: chain exhausted: fails all_burnt with every hop and skip. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `wait-for-reset: waits until the earliest reset, then resumes in the same session on that account` | Protects the distinct failure specified by this case: wait-for-reset: waits until the earliest reset, then resumes in the same session on that account. No equivalent scenario at another retained owner covers this input transition. |
| REWRITE | `wait-for-reset refuses a reset beyond maxWaitHours` | Protects the distinct failure specified by this case: wait-for-reset refuses a reset beyond maxWaitHours. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `an auth failure skips the account (1 h cooldown, unusable for the run) and fails over` | Protects the distinct failure specified by this case: an auth failure skips the account (1 h cooldown, unusable for the run) and fails over. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `at most 12 hops: a chain of 14 burnt accounts gives up with limit_exceeded` | Protects the distinct failure specified by this case: at most 12 hops: a chain of 14 burnt accounts gives up with limit_exceeded. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `the cooldown is shared: the next block skips the burnt account` | Protects the distinct failure specified by this case: the cooldown is shared: the next block skips the burnt account. No equivalent scenario at another retained owner covers this input transition. |
| DELETE | `a hop never burns the same account twice unless its cooldown expired` | Same two-account exhausted sequence already asserted with four accounts by chain-exhausted and reset tests. |
| KEEP | `a model the catalogue does not list skips its chain entry (why: catalog) and the next entry runs` | Protects the distinct failure specified by this case: a model the catalogue does not list skips its chain entry (why: catalog) and the next entry runs. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `wait-for-reset over 48 h with limits that never name a reset: resumed hops are not counted, cooldowns escalate` | Protects the distinct failure specified by this case: wait-for-reset over 48 h with limits that never name a reset: resumed hops are not counted, cooldowns escalate. No equivalent scenario at another retained owner covers this input transition. |
| DELETE | `hopCapReached counts every hop but a resumed one` | Duplicate of the 14-account cap and 48-hour reset executor scenarios; private counter shape is not an additional contract. |
| KEEP | `coolDown keys accountless launches by provider and never reads another quota's reset` | Protects the distinct failure specified by this case: coolDown keys accountless launches by provider and never reads another quota's reset. No equivalent scenario at another retained owner covers this input transition. |

## `apps/daemon/src/workflows/agent/families.test.ts`

Independent contract (bar 1): §5.2 and §5.4 account family / provider quota isolation; persisted workflow-state keys. Visible failure (bar 2): the scenario named in each retained row produces wrong caller-visible data/state, persistence, command, or process outcome. Independent oracle (bar 3): fixed input/output values and errors from that contract; rewrite rows below remove computed oracles. Stable seam (bar 4): family/quota resolver and persisted router-state reader. Refactor tolerance (bar 5): assert results of that seam, no source spelling, helper inventory, classes or private call count. Ownership (bar 6): select.test.ts owns selection; remaining key and disk cases isolate distinct persisted keys and tolerant state reads. Non-test callers: select.ts, failover.ts, daemon-wiring.ts.

Risk: low for removal of duplicate/private assertions; protocol/storage/security edge cases remain. Validation: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test <retained assigned paths>` from `apps/daemon`, then root `pnpm check` / `pnpm test`.

| Disposition | Original case | Reason / detected failure |
| --- | --- | --- |
| DELETE | `accountFamilyOf follows the daemon's proxyAccountFamily(refId) ?? refId` | Compares one implementation against another. Account family, proxy and prototype-safe rejection behavior remains in selectAccount and daemon account-validation contracts. |
| DELETE | `isProxyLauncher is exactly the proxy launchers` | Implementation-derived declaration check; selection and executor protocol tests exercise actual proxy launch behavior. |
| DELETE | `usesAccount: router and xAI claudex models carry no account; claudemix always does` | Duplicates select.test.ts claudex/claudemix and accountless provider selection plus shared router resolution contracts. |
| REWRITE | `routerProvidersFromDisk reads the proxy state, [] when absent or corrupt` | Retain disk compatibility cases; register temporary-directory cleanup. |
| KEEP | `cooldownSubject: one key per quota — accountless launches keyed by provider, the proxy's pick apart` | Protects the distinct failure specified by this case: cooldownSubject: one key per quota — accountless launches keyed by provider, the proxy's pick apart. No equivalent scenario at another retained owner covers this input transition. |

## `apps/daemon/src/workflows/agent/helpers.test.ts`

Independent contract (bar 1): §5.1 output boundary, §5.4 baseline-relative failures, §5.5 unattended watcher. Visible failure (bar 2): the scenario named in each retained row produces wrong caller-visible data/state, persistence, command, or process outcome. Independent oracle (bar 3): fixed input/output values and errors from that contract; rewrite rows below remove computed oracles. Stable seam (bar 4): pure owner transformations consumed by executor/watch. Refactor tolerance (bar 5): assert results of that seam, no source spelling, helper inventory, classes or private call count. Ownership (bar 6): retain only baseline, UTF-8 limit, output/history selection and wire-construction cases absent from whole-executor scenarios; duplicated wrappers removed. Non-test callers: executor.ts, watch.ts, failover.ts.

Risk: low for removal of duplicate/private assertions; protocol/storage/security edge cases remain. Validation: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test <retained assigned paths>` from `apps/daemon`, then root `pnpm check` / `pnpm test`.

| Disposition | Original case | Reason / detected failure |
| --- | --- | --- |
| DELETE | `the autonomy note is appended exactly as the spec words it` | Declaration assertion and wrapper formatting duplicate the executor send contract. Executor assertion will use the specification literal independently of the production constant. |
| KEEP | `UTF-8 clipping never splits a code point; the tail keeps the newest part` | Protects the distinct failure specified by this case: UTF-8 clipping never splits a code point; the tail keeps the newest part. No equivalent scenario at another retained owner covers this input transition. |
| DELETE | `the handoff prompt: original prompt, notice, messages, git status, autonomy note` | Composes the expected string from production helpers; the failover cross-family scenario already observes the transmitted prompt and original messages. |
| KEEP | `failures are read structurally, only after the baseline, with the legacy prefix only for reason-less rows` | Protects the distinct failure specified by this case: failures are read structurally, only after the baseline, with the legacy prefix only for reason-less rows. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `a baseline row that left the window falls back to the time cut` | Protects the distinct failure specified by this case: a baseline row that left the window falls back to the time cut. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `the baseline takes the thread's latest turn over a lagging summary` | Protects the distinct failure specified by this case: the baseline takes the thread's latest turn over a lagging summary. No equivalent scenario at another retained owner covers this input transition. |
| DELETE | `autonomous answers and decisions` | Duplicates executor question/approval scenarios with private helper output. |
| KEEP | `the output is the latest settled turn's parent answer: commentary only when it is all, agents' words never, re-emitted Claude copies dropped` | Protects the distinct failure specified by this case: the output is the latest settled turn's parent answer: commentary only when it is all, agents' words never, re-emitted Claude copies dropped. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `the output text is capped at 2 MiB` | Protects the distinct failure specified by this case: the output text is capped at 2 MiB. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `the handoff reads the parent's words since the block began in the session` | Protects the distinct failure specified by this case: the handoff reads the parent's words since the block began in the session. No equivalent scenario at another retained owner covers this input transition. |
| REWRITE | `the create body: explicit account, full access, owner; a top-level model for claudex only` | Retain explicit session protocol fields and proxy model placement; delete session-title formatting assertions. |
| KEEP | `exclusions: tried accounts only while their cooldown runs; unusable ones for good` | Protects the distinct failure specified by this case: exclusions: tried accounts only while their cooldown runs; unusable ones for good. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `wait-for-reset honours maxWaitHours from the first wait` | Protects the distinct failure specified by this case: wait-for-reset honours maxWaitHours from the first wait. No equivalent scenario at another retained owner covers this input transition. |
| DELETE | `the account preview decides as the block does (the owner's example), cooldowns included` | Repeats select.test.ts ranking and e2e-agent.test.ts account-preview before/after a real run. |
| KEEP | `the activity line reads tool calls and assistant text, never a provider's stderr or warnings` | Protects the distinct failure specified by this case: the activity line reads tool calls and assistant text, never a provider's stderr or warnings. No equivalent scenario at another retained owner covers this input transition. |

## `apps/daemon/src/workflows/agent/invariant.test.ts`

Independent contract (bar 1): §5.4 failover invariant. Visible failure (bar 2): the scenario named in each retained row produces wrong caller-visible data/state, persistence, command, or process outcome. Independent oracle (bar 3): fixed input/output values and errors from that contract; rewrite rows below remove computed oracles. Stable seam (bar 4): createAgentExecutor. Refactor tolerance (bar 5): assert results of that seam, no source spelling, helper inventory, classes or private call count. Ownership (bar 6): explicit failover/resume scenarios are stronger reproducible owners. Non-test callers: daemon-wiring.ts.

Risk: low for removal of duplicate/private assertions; protocol/storage/security edge cases remain. Validation: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test <retained assigned paths>` from `apps/daemon`, then root `pnpm check` / `pnpm test`.

| Disposition | Original case | Reason / detected failure |
| --- | --- | --- |
| DELETE | `random limit schedules never fail the block while an eligible candidate remains` | Repeats the explicit failover matrix and restart matrix with a random harness/order oracle and coverage tally; no distinct specified failure beyond those named scenarios. |

## `apps/daemon/src/workflows/agent/resume.test.ts`

Independent contract (bar 1): §5.7 no persisted secret values and §5.8 durable wait/command identity across restart. Visible failure (bar 2): the scenario named in each retained row produces wrong caller-visible data/state, persistence, command, or process outcome. Independent oracle (bar 3): fixed input/output values and errors from that contract; rewrite rows below remove computed oracles. Stable seam (bar 4): new executor resumed from persisted WaitingOn. Refactor tolerance (bar 5): assert results of that seam, no source spelling, helper inventory, classes or private call count. Ownership (bar 6): normal execution does not cover crashes at persisted phases or lost responses; fake host receipts supply the remote boundary, while assertions prove executor reuse of command IDs. Non-test callers: engine.ts / daemon-wiring.ts.

Risk: low for removal of duplicate/private assertions; protocol/storage/security edge cases remain. Validation: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test <retained assigned paths>` from `apps/daemon`, then root `pnpm check` / `pnpm test`.

| Disposition | Original case | Reason / detected failure |
| --- | --- | --- |
| DELETE | `every phase of the vocabulary is covered by a restart case` | Declaration/coverage inventory of AGENT_PHASES, not behavior. |
| REWRITE | `name` | Protects the distinct failure specified by this case: name. No equivalent scenario at another retained owner covers this input transition. |
| DELETE | `a re-posted turn reuses the persisted commandId and is deduplicated by the host's receipts` | Exact duplicate of the restart watching/plain/lostAck:sending matrix entry; that entry retains command identity checks. |
| KEEP | `a persisted state this version cannot read ends the block interrupted` | Protects the distinct failure specified by this case: a persisted state this version cannot read ends the block interrupted. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `the deadline is wall-clock: a resumed block does not get its maxMinutes again` | Protects the distinct failure specified by this case: the deadline is wall-clock: a resumed block does not get its maxMinutes again. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | ``a secret in the prompt is never persisted, and a restart at ${phase} still sends the real value`` | Protects the distinct failure specified by this case: `a secret in the prompt is never persisted, and a restart at ${phase} still sends the real value`. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `a handoff prompt carrying the secret keeps it out of the state and sends the real value` | Protects the distinct failure specified by this case: a handoff prompt carrying the secret keeps it out of the state and sends the real value. No equivalent scenario at another retained owner covers this input transition. |

## `apps/daemon/src/workflows/agent/secret-text.test.ts`

Independent contract (bar 1): §5.7 secret values kept out of resumable state, AGENTS host-only secret rule. Visible failure (bar 2): the scenario named in each retained row produces wrong caller-visible data/state, persistence, command, or process outcome. Independent oracle (bar 3): fixed input/output values and errors from that contract; rewrite rows below remove computed oracles. Stable seam (bar 4): protectSecrets/revealSecrets persisted marker codec. Refactor tolerance (bar 5): assert results of that seam, no source spelling, helper inventory, classes or private call count. Ownership (bar 6): resume suite covers actual persistence; overlapping secret names, vanished names and precise marker decoding remain codec-only edge cases. Non-test callers: executor.ts.

Risk: low for removal of duplicate/private assertions; protocol/storage/security edge cases remain. Validation: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test <retained assigned paths>` from `apps/daemon`, then root `pnpm check` / `pnpm test`.

| Disposition | Original case | Reason / detected failure |
| --- | --- | --- |
| REWRITE | `protectSecrets hides every value (longest first, ≥ 4 chars); revealSecrets restores the exact text` | Replace expected text built by secretMarker with literal persisted marker bytes; retain independent redaction and exact round-trip expectations. |
| KEEP | `a secret whose value is another secret's name never corrupts a marker` | Protects the distinct failure specified by this case: a secret whose value is another secret's name never corrupts a marker. No equivalent scenario at another retained owner covers this input transition. |
| REWRITE | `a marker for a secret that no longer exists is sent as nothing; text without markers is untouched` | Read literal persisted marker bytes rather than constructing the input with the matching encoder. |

## `apps/daemon/src/workflows/agent/select.test.ts`

Independent contract (bar 1): §5.2 explicit account-selection policy and example. Visible failure (bar 2): the scenario named in each retained row produces wrong caller-visible data/state, persistence, command, or process outcome. Independent oracle (bar 3): fixed input/output values and errors from that contract; rewrite rows below remove computed oracles. Stable seam (bar 4): selectAccount/rankChainEntry/burntWindowResetAt policy seam. Refactor tolerance (bar 5): assert results of that seam, no source spelling, helper inventory, classes or private call count. Ownership (bar 6): executor tests cover command flow with fixed selection; these input matrices uniquely prove quota thresholds, stale/unknown readings, family joins and stable ranking. Non-test callers: preview.ts / failover.ts.

Risk: low for removal of duplicate/private assertions; protocol/storage/security edge cases remain. Validation: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test <retained assigned paths>` from `apps/daemon`, then root `pnpm check` / `pnpm test`.

| Disposition | Original case | Reason / detected failure |
| --- | --- | --- |
| REWRITE | `owner's example: soonest weekly reset under 85% picks jasperclaude and skips therealeduard465` | Retain chosen identity/rank, skip reason codes and reset timestamps; discard exact explanatory wording and self-derived reading fields where present. |
| REWRITE | `soonest-reset without a threshold takes the earliest weekly reset` | Retain chosen identity/rank, skip reason codes and reset timestamps; discard exact explanatory wording and self-derived reading fields where present. |
| REWRITE | `soonest-reset on the session window: unknown resets go last` | Retain chosen identity/rank, skip reason codes and reset timestamps; discard exact explanatory wording and self-derived reading fields where present. |
| REWRITE | `least-used (max) picks jasperinuwu` | Retain chosen identity/rank, skip reason codes and reset timestamps; discard exact explanatory wording and self-derived reading fields where present. |
| REWRITE | `least-used ties break on the soonest weekly reset, then the label` | Retain chosen identity/rank, skip reason codes and reset timestamps; discard exact explanatory wording and self-derived reading fields where present. |
| REWRITE | `fixed order [therealeduard465, jasperclaude] under 85% weekly picks jasperclaude — by label or by id` | Retain chosen identity/rank, skip reason codes and reset timestamps; discard exact explanatory wording and self-derived reading fields where present. |
| REWRITE | `an allow-list filters the family, and names what it cannot find` | Retain chosen identity/rank, skip reason codes and reset timestamps; discard exact explanatory wording and self-derived reading fields where present. |
| REWRITE | `a scoped threshold applies only to the models it names` | Retain chosen identity/rank, skip reason codes and reset timestamps; discard exact explanatory wording and self-derived reading fields where present. |
| REWRITE | `a window at 100% is always burnt; a burnt scoped window stops only the models it covers` | Retain chosen identity/rank, skip reason codes and reset timestamps; discard exact explanatory wording and self-derived reading fields where present. |
| REWRITE | `expired windows are ignored: a pre-reset 100% no longer blocks` | Retain chosen identity/rank, skip reason codes and reset timestamps; discard exact explanatory wording and self-derived reading fields where present. |
| REWRITE | `unknown usage is tried after every known account — or dropped with unknownUsage: exclude` | Retain chosen identity/rank, skip reason codes and reset timestamps; discard exact explanatory wording and self-derived reading fields where present. |
| DELETE | `staleAfterMs is configurable` | Only test passes this internal override; requirement fixes stale usage at 20 minutes and unknown-usage case covers that behavior. |
| REWRITE | `needsReauth, cooldowns and the exclude set drop candidates` | Retain chosen identity/rank, skip reason codes and reset timestamps; discard exact explanatory wording and self-derived reading fields where present. |
| REWRITE | `an expired cooldown no longer counts` | Retain chosen identity/rank, skip reason codes and reset timestamps; discard exact explanatory wording and self-derived reading fields where present. |
| REWRITE | `cross-family fallback: claude (all burnt or cooling) → codex (reauth, burnt) → grok` | Retain chosen identity/rank, skip reason codes and reset timestamps; discard exact explanatory wording and self-derived reading fields where present. |
| REWRITE | `nothing eligible anywhere: chosen null and the earliest instant a candidate frees` | Retain chosen identity/rank, skip reason codes and reset timestamps; discard exact explanatory wording and self-derived reading fields where present. |
| REWRITE | `a threshold breach with an unknown reset contributes no earliest instant` | Retain chosen identity/rank, skip reason codes and reset timestamps; discard exact explanatory wording and self-derived reading fields where present. |
| REWRITE | `opencode has no accounts: one system candidate, only its cooldown applies` | Retain chosen identity/rank, skip reason codes and reset timestamps; discard exact explanatory wording and self-derived reading fields where present. |
| REWRITE | `claudex/claudemix: only seeded accounts; router and xAI models run without one` | Retain chosen identity/rank, skip reason codes and reset timestamps; discard exact explanatory wording and self-derived reading fields where present. |
| REWRITE | `system: the family's system row, or its head row when it has no managed accounts` | Retain chosen identity/rank, skip reason codes and reset timestamps; discard exact explanatory wording and self-derived reading fields where present. |
| REWRITE | `sameFamilyAlternatives: the next eligible account of the same chain entry, never another entry` | Retain chosen identity/rank, skip reason codes and reset timestamps; discard exact explanatory wording and self-derived reading fields where present. |
| REWRITE | `chosen carries the entry's model options` | Retain chosen identity/rank, skip reason codes and reset timestamps; discard exact explanatory wording and self-derived reading fields where present. |
| REWRITE | `burntWindowResetAt: the latest reset among burnt windows` | Retain chosen identity/rank, skip reason codes and reset timestamps; discard exact explanatory wording and self-derived reading fields where present. |
| DELETE | `formatDuration` | Exact explanatory copy and rounding presentation without an independent wording contract. |
| REWRITE | `accountless cooldowns are per provider: one provider's limit never cools another's entries` | Retain chosen identity/rank, skip reason codes and reset timestamps; discard exact explanatory wording and self-derived reading fields where present. |

## `apps/daemon/src/workflows/agent/validation-catalog.test.ts`

Independent contract (bar 1): §7.2 unknown-model validation must not reject an unprobed provider. Visible failure (bar 2): the scenario named in each retained row produces wrong caller-visible data/state, persistence, command, or process outcome. Independent oracle (bar 3): fixed input/output values and errors from that contract; rewrite rows below remove computed oracles. Stable seam (bar 4): toValidationCatalog and createValidationCatalog. Refactor tolerance (bar 5): assert results of that seam, no source spelling, helper inventory, classes or private call count. Ownership (bar 6): API schema tests know no provider loading status; these cases distinguish unknown catalogs from known unsupported models. Non-test callers: daemon-wiring.ts workflow save validation.

Risk: low for removal of duplicate/private assertions; protocol/storage/security edge cases remain. Validation: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test <retained assigned paths>` from `apps/daemon`, then root `pnpm check` / `pnpm test`.

| Disposition | Original case | Reason / detected failure |
| --- | --- | --- |
| KEEP | `a provider's models count only once it has been probed; claudex's proxy list whenever it lists any` | Protects the distinct failure specified by this case: a provider's models count only once it has been probed; claudex's proxy list whenever it lists any. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `nothing is known before the client is attached; ready() then reads the host's catalogue` | Protects the distinct failure specified by this case: nothing is known before the client is attached; ready() then reads the host's catalogue. No equivalent scenario at another retained owner covers this input transition. |

## `apps/daemon/src/workflows/nodes/nodes.test.ts`

Independent contract (bar 1): §4 Wait block timezone and §5.6/§5.9 shell output limits. Visible failure (bar 2): the scenario named in each retained row produces wrong caller-visible data/state, persistence, command, or process outcome. Independent oracle (bar 3): fixed input/output values and errors from that contract; rewrite rows below remove computed oracles. Stable seam (bar 4): WorkflowEngine.run/waitForRun with real shell executor. Refactor tolerance (bar 5): assert results of that seam, no source spelling, helper inventory, classes or private call count. Ownership (bar 6): timezone wait and shell output-tail retention are distinct from sandbox raw-log caps. Non-test callers: nodes/index.ts and engine.ts.

Risk: low for removal of duplicate/private assertions; protocol/storage/security edge cases remain. Validation: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test <retained assigned paths>` from `apps/daemon`, then root `pnpm check` / `pnpm test`.

| Disposition | Original case | Reason / detected failure |
| --- | --- | --- |
| KEEP | `until HH:MM waits for the next such time in the block's time zone` | Protects the distinct failure specified by this case: until HH:MM waits for the next such time in the block's time zone. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `the workflow's own time zone applies when the block names none` | Protects the distinct failure specified by this case: the workflow's own time zone applies when the block names none. No equivalent scenario at another retained owner covers this input transition. |
| REWRITE | `stdout and stderr are the tails within the cap, with a warning; the whole log stays on disk` | Protects the distinct failure specified by this case: stdout and stderr are the tails within the cap, with a warning; the whole log stays on disk. No equivalent scenario at another retained owner covers this input transition. |

## `apps/daemon/src/workflows/nodes/regex-worker.test.ts`

Independent contract (bar 1): §4 matches must not block daemon; §5.7 secret redaction before warning clipping. Visible failure (bar 2): the scenario named in each retained row produces wrong caller-visible data/state, persistence, command, or process outcome. Independent oracle (bar 3): fixed input/output values and errors from that contract; rewrite rows below remove computed oracles. Stable seam (bar 4): RegexMatcher.match and API evaluateRulesAsync. Refactor tolerance (bar 5): assert results of that seam, no source spelling, helper inventory, classes or private call count. Ownership (bar 6): real worker lifecycle/deadline is unavailable to pure API regex guards; warning clipping regression tests fixed secret bytes. Non-test callers: flow.ts.

Risk: low for removal of duplicate/private assertions; protocol/storage/security edge cases remain. Validation: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test <retained assigned paths>` from `apps/daemon`, then root `pnpm check` / `pnpm test`.

| Disposition | Original case | Reason / detected failure |
| --- | --- | --- |
| KEEP | `an ordinary pattern answers` | Protects the distinct failure specified by this case: an ordinary pattern answers. No equivalent scenario at another retained owner covers this input transition. |
| REWRITE | `a catastrophic pattern is stopped at the deadline, the loop stays free, and the next search works` | Use the production matcher defaults and assert a warning exists rather than pinning prose; retain deadline, event-loop progress and successful recovery. |
| DELETE | `an IF over a slow pattern reads false with a warning (evaluateRulesAsync)` | Passes whether the worker is used or not and never asserts its warning; worker deadline test and shared API rule dispatch own this behavior. |
| KEEP | `a clipped value is redacted before the clip` | Protects the distinct failure specified by this case: a clipped value is redacted before the clip. No equivalent scenario at another retained owner covers this input transition. |

## `apps/daemon/src/workflows/sandbox/log-reader.test.ts`

Independent contract (bar 1): §5.6 file logs, §5.7 redaction, public byte-offset log streaming contract. Visible failure (bar 2): the scenario named in each retained row produces wrong caller-visible data/state, persistence, command, or process outcome. Independent oracle (bar 3): fixed input/output values and errors from that contract; rewrite rows below remove computed oracles. Stable seam (bar 4): readLogWindow/followLog with actual files. Refactor tolerance (bar 5): assert results of that seam, no source spelling, helper inventory, classes or private call count. Ownership (bar 6): redactor units do not own byte offsets, live-file growth, missing files or abort lifecycle. Non-test callers: workflow routes / run-store readers.

Risk: low for removal of duplicate/private assertions; protocol/storage/security edge cases remain. Validation: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test <retained assigned paths>` from `apps/daemon`, then root `pnpm check` / `pnpm test`.

| Disposition | Original case | Reason / detected failure |
| --- | --- | --- |
| KEEP | `windows of any size cut at character boundaries and join to the whole text` | Protects the distinct failure specified by this case: windows of any size cut at character boundaries and join to the whole text. No equivalent scenario at another retained owner covers this input transition. |
| REWRITE | `a secret is never split across windows` | Replace text() expected output with explicit placeholder bytes; retain real-file windows and no leaked secret. |
| KEEP | `an offset inside a secret serves its placeholder, never its tail` | Protects the distinct failure specified by this case: an offset inside a secret serves its placeholder, never its tail. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `holdTail keeps back a partial character and a possible secret prefix` | Protects the distinct failure specified by this case: holdTail keeps back a partial character and a possible secret prefix. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `a missing file reads as empty` | Protects the distinct failure specified by this case: a missing file reads as empty. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `yields as the file grows and ends once it is not live and fully read` | Protects the distinct failure specified by this case: yields as the file grows and ends once it is not live and fully read. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `an abort ends a live follow` | Protects the distinct failure specified by this case: an abort ends a live follow. No equivalent scenario at another retained owner covers this input transition. |

## `apps/daemon/src/workflows/sandbox/redact.test.ts`

Independent contract (bar 1): §5.7 literal longest-first secret redaction through values and stream chunks. Visible failure (bar 2): the scenario named in each retained row produces wrong caller-visible data/state, persistence, command, or process outcome. Independent oracle (bar 3): fixed input/output values and errors from that contract; rewrite rows below remove computed oracles. Stable seam (bar 4): createRedactor and stream push/flush. Refactor tolerance (bar 5): assert results of that seam, no source spelling, helper inventory, classes or private call count. Ownership (bar 6): unit seam owns literal matching and streaming chunk splits; file-window seam separately owns offsets and partial bytes. Non-test callers: run-context.ts, log-reader.ts, secret-text.ts.

Risk: low for removal of duplicate/private assertions; protocol/storage/security edge cases remain. Validation: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test <retained assigned paths>` from `apps/daemon`, then root `pnpm check` / `pnpm test`.

| Disposition | Original case | Reason / detected failure |
| --- | --- | --- |
| KEEP | `text: every value ≥ 4 chars, longest first` | Protects the distinct failure specified by this case: text: every value ≥ 4 chars, longest first. No equivalent scenario at another retained owner covers this input transition. |
| REWRITE | `value: deep through arrays and objects, values only` | Remove reference-identity assertion; retain exact transformed data and unchanged input data. |
| DELETE | `no secrets: identity` | Reference-identity implementation constraint; short-value passthrough is already covered in text redaction. |
| KEEP | `special regex characters in a value are literal` | Protects the distinct failure specified by this case: special regex characters in a value are literal. No equivalent scenario at another retained owner covers this input transition. |
| DELETE | `byteMatches agrees with text matching on UTF-8` | Private byte matcher overlap with the actual log-window UTF-8 secret contract. |
| REWRITE | `every two-chunk split gives exactly text()'s answer` | Replace production text() oracle with an explicit secret-placeholder literal; retain all chunk boundaries. |
| REWRITE | `one character at a time never emits part of a secret` | Use the same independently specified literal output; retain each intermediate no-leak assertion. |
| DELETE | `redactChunk returns what to hold back` | Private carry shape duplicate; public push/flush tests cover every split and secret-prefix protection. |

## `apps/daemon/src/workflows/sandbox/sandbox.test.ts`

Independent contract (bar 1): §5.6/§5.8 actual code/shell process, cancellation, recovery and host credential isolation. Visible failure (bar 2): the scenario named in each retained row produces wrong caller-visible data/state, persistence, command, or process outcome. Independent oracle (bar 3): fixed input/output values and errors from that contract; rewrite rows below remove computed oracles. Stable seam (bar 4): SandboxRunner.spawn/wait/kill with real child processes and disk IO. Refactor tolerance (bar 5): assert results of that seam, no source spelling, helper inventory, classes or private call count. Ownership (bar 6): engine harnesses use fake processes; only this owner catches actual environment, process-group, orphan, module-loading and persisted-handle failures. Non-test callers: code/shell executors and engine resume.

Risk: low for removal of duplicate/private assertions; protocol/storage/security edge cases remain. Validation: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test <retained assigned paths>` from `apps/daemon`, then root `pnpm check` / `pnpm test`.

| Disposition | Original case | Reason / detected failure |
| --- | --- | --- |
| KEEP | `a return value is the result; log() and console.log reach stdout` | Protects the distinct failure specified by this case: a return value is the result; log() and console.log reach stdout. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `undefined returns as null` | Protects the distinct failure specified by this case: undefined returns as null. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `a throw is a failure with message and stack` | Protects the distinct failure specified by this case: a throw is a failure with message and stack. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `stop() ends the run as stopped, with its reason, even from a promise chain` | Protects the distinct failure specified by this case: stop() ends the run as stopped, with its reason, even from a promise chain. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `require resolves the project's own node_modules` | Protects the distinct failure specified by this case: require resolves the project's own node_modules. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `a module with top-level await works` | Protects the distinct failure specified by this case: a module with top-level await works. No equivalent scenario at another retained owner covers this input transition. |
| REWRITE | `a non-serializable return is an error` | Protects the distinct failure specified by this case: a non-serializable return is an error. No equivalent scenario at another retained owner covers this input transition. |
| REWRITE | `a return over maxOutputBytes is an error` | Protects the distinct failure specified by this case: a return over maxOutputBytes is an error. No equivalent scenario at another retained owner covers this input transition. |
| REWRITE | `a default export that is not a function is a clear error` | Protects the distinct failure specified by this case: a default export that is not a function is a clear error. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `a syntax error is a failure` | Protects the distinct failure specified by this case: a syntax error is a failure. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `an open handle does not hold the attempt` | Protects the distinct failure specified by this case: an open handle does not hold the attempt. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `stdout, stderr and the exit code` | Protects the distinct failure specified by this case: stdout, stderr and the exit code. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `sh works too, and the cwd is the request's` | Protects the distinct failure specified by this case: sh works too, and the cwd is the request's. No equivalent scenario at another retained owner covers this input transition. |
| REWRITE | `each stream is capped with one notice line` | Protects the distinct failure specified by this case: each stream is capped with one notice line. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `the environment is built, never inherited` | Protects the distinct failure specified by this case: the environment is built, never inherited. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `an invalid env name refuses the spawn` | Protects the distinct failure specified by this case: an invalid env name refuses the spawn. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `a missing cwd refuses the spawn` | Protects the distinct failure specified by this case: a missing cwd refuses the spawn. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `the runner enforces the deadline itself` | Protects the distinct failure specified by this case: the runner enforces the deadline itself. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `a work that ignores SIGTERM is SIGKILLed after the grace` | Protects the distinct failure specified by this case: a work that ignores SIGTERM is SIGKILLed after the grace. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `a cancel kills the whole group, grandchildren included` | Protects the distinct failure specified by this case: a cancel kills the whole group, grandchildren included. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `kill() ends a running attempt` | Protects the distinct failure specified by this case: kill() ends a running attempt. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `a runner killed outright reads as interrupted, and its work is ended` | Protects the distinct failure specified by this case: a runner killed outright reads as interrupted, and its work is ended. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `a restarted daemon adopts a running attempt and reads its exit` | Protects the distinct failure specified by this case: a restarted daemon adopts a running attempt and reads its exit. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `readExit is null before an attempt ends` | Protects the distinct failure specified by this case: readExit is null before an attempt ends. No equivalent scenario at another retained owner covers this input transition. |
| KEEP | `isAlive refuses a recycled pid (starttime mismatch)` | Protects the distinct failure specified by this case: isAlive refuses a recycled pid (starttime mismatch). No equivalent scenario at another retained owner covers this input transition. |

## Restart family expansion

`test(name)` in resume.test.ts covers plain selecting/creating/sending/watching/output; plain sending with creating acknowledgment lost; plain watching with sending acknowledgment lost; question answering and second watching with answering acknowledgment lost; switch interrupting/waiting-idle/failing-over/switching/second sending/second watching, including second sending with switching acknowledgment lost; handoff handing-off/second creating/second sending with creating acknowledgment lost; reset waiting-reset/second failing-over/second sending. Each persists before a different external side effect or wait, resumes in a fresh executor, expects the configured final reply and exact session count, and rejects duplicate commands. Secret family: restart at creating and sending independently verifies every persisted record contains no secret and the transmitted command contains the original secret.

## Planned dead support/seams

Remove invariant random generator with its test; privatize AGENT_PHASES and redactChunk after their sole direct tests disappear; remove test-only usage staleness override; remove now-unused imports and scenario timing override if no remaining production use requires it. Preserve real workflow clocks, process limits and daemon APIs used by runtime callers.

## Validation and final changes

Implemented cleanup. Focused final scope run: **158 passed, 0 failed**, using all surviving paths in the original scope with the existing daemon Node import hooks. Log: `/tmp/orquester-test-cleanup/workflow-execution-final.log`. The real 16 MiB shell test initially read the documented inline preview as the full output; it now reads through `engine.nodeOutput` and passes. No production behavior was changed for that correction. Repository gates and cross-scope storage/timer updates are recorded in the main report.

### Follow-up seam decisions recorded before editing

REWRITE `sandbox.test.ts` / `a return over maxOutputBytes is an error` and `each stream is capped with one notice line`: use actual specified 16 MiB result / 50 MiB log bounds rather than installing a test cap of 1,000 bytes. REWRITE `nodes.test.ts` / `stdout and stderr are the tails within the cap, with a warning; the whole log stays on disk`: exercise the actual 16 MiB output cap with a real oversized log. The independent bounds are §5.9; errors, truncation flags, literal output tails and the unchanged on-disk log are the caller-visible failures. Real SandboxRunner / WorkflowEngine are the stable seams; fixed byte data survives refactoring and no other owner covers raw-log vs downstream-output caps. Risk: these tests write larger temporary artifacts and take longer; directories still cleaned.

Remove SandboxRunner's unused nodePath and test-only poll/grace/cap overrides (factory passes only clock/logger/appdirTmp), ShellExecutorOptions cap forwarding, RegexMatcher's test-only timeout option, Scenario.timings and AgentExecutor/WatchInput timing overrides. Production clock services remain because runtime callers provide them. The daemon-harness/daemon-wiring timing forwarding fields have no actual caller, and their owner will remove them. Preserve all existing default durations and limits. Make AGENT_PHASES, DEFAULT_AGENT_TIMINGS, DEFAULT_USAGE_STALE_AFTER_MS, secretMarker and describeSkip private where repo-wide search confirms only in-module production callers.

Final review decisions recorded before follow-up edits: sandbox timeout/path constants,
regex deadline constant and watch.backgroundEndedAt have no callers outside their owners
(or an otherwise-unused barrel), so make them private. REWRITE sandbox error/log-cap cases
and node shell-cap case: remove presentation wording, retain failure status/nonempty error,
actual byte bound, a single nonempty notice, truncation flags and stderr payload. Read the
large output through public `engine.nodeOutput`, since `getRun` intentionally returns a
preview. REWRITE failover exhausted/reset messages to assert existing structured error data
only. REWRITE resume matrix command checks: remove fake receipt uniqueness and fake turn
counter equality; compare emitted protocol command IDs on reposts and literal expected
user-message counts, preserving output/session/durable-state checks. These observations
remain at the existing protocol/process seams, detect duplicate user submissions and lost
output, and survive private implementation changes. Replace fixed timer polling in sandbox
support with event-loop yields while checking real file/process readiness; no simulated
production timeout is introduced.

A final caller audit found `FollowLogOptions.pollMs` and `chunkBytes` supplied only by
retained log-reader tests (routes uses the defaults). Remove both overrides and keep the
existing growing-file/abort assertions at the actual production follower. Redaction window
boundaries already have independent byte/UTF-8 matrix coverage at `readLogWindow`; the
follower owns lifecycle and ordered incremental delivery, so it needs no artificial window.
