# OpenCode pool and Claude history seam follow-up

This implemented follow-up supersedes the affected rows in `adapter_claude_opencode.md`; all other original dispositions there remain valid. Decisions recorded before edits.

## OpenCode server pool

Production caller: `opencode/index.ts` constructs one pool from logger, binary resolution, project environment, shutdown signal and stderr reporting. Repository-wide constructor/property search found no production override of idle duration, password generation, timer functions, hostname or fetch. The public handle's password field has no production reader; only a server test and a session-test fake mention it. Remove those options and the unused password observer; keep credentials private to the pool's clients. The normal defaults remain 30 seconds, loopback, native timers, native fetch and a fresh random password.

Failure modes before retaining isolated pool coverage: wrong stdout adoption; false readiness from unrelated output; unauthenticated health/client calls; unsuitable or dead servers adopted; startup abort stranded; final release leaks a child; earlier release kills another thread's child; re-acquisition fails to cancel idle closure; concurrent starts fork duplicate servers; project isolation fails; repeated shutdown returns before children exit. Independent sources are GUI design §§3.1–3.2 and §4.5, plus OpenCode fixture README readiness and credential observations.

Full bar for every KEEP and REWRITE below: (1) those independent process, auth and sharing contracts specify the outcome; (2) the listed failure breaks a real session's acquisition, request or process lifetime; (3) assertions use literal HTTP status/data, expected project-sharing identities, captured stdout framing or real child exit, never the implementation's password encoder; (4) the seam is the production pool/client against a real process and HTTP peer, with native timer mocking only to advance its documented idle deadline; (5) pool/refcount/timer internals may be refactored while these external outcomes hold; (6) HTTP-only session tests cannot prove subprocess lifetime or credential delivery during adoption, and existing source/helper duplicates remain deleted.

| Disposition | Original case | Failure / stronger owner |
| --- | --- | --- |
| KEEP | the readiness scrape stays line-oriented past the unsecured-server warning | Observed provider stdout warning cannot hide its subsequent ready URL. |
| KEEP | the scrape ignores a line that merely mentions the phrase | Unrelated failure output cannot be adopted as a ready endpoint; distinct from a real prefix. |
| REWRITE | a healthy peer is adopted, and the URL comes off stdout | Real process launch/readiness/health must return a usable loopback server handle. |
| REWRITE | `/global/health` is reached WITH the credential, as the real server demands | Use the generated credential: unauthenticated wire request is 401, real handle client gets healthy data, decoded Basic username is literal `opencode` with a nonempty password. Remove injected password and production-encoder oracle. |
| REWRITE | a server below the minimum is REFUSED with the required version in the message | Supported-version gate refuses observed old 1.10.0 server. |
| KEEP | an unhealthy server is refused rather than adopted | Provider's unhealthy response cannot become a usable session. |
| KEEP | a peer that dies before printing a ready line fails with its stderr excerpt | Startup death returns a caller error carrying the peer's failure. |
| KEEP | a bad binary fails the acquire instead of hanging | Missing executable settles acquisition as failure. |
| KEEP | a host abort cancels acquisition of a silent peer | Real shutdown signal ends an acquisition already waiting on readiness; no password bypass needed. |
| REWRITE | threads of one project share one server, ref-counted, closed after the last release | Advance native timers at the production 30-second boundary; one retained reference stays usable, final release closes only at the deadline. Removes 10ms test configuration. |
| REWRITE | a re-acquire inside the idle window cancels the close | Cross the old deadline after reacquiring and verify the child still answers HTTP, then verify last release still closes it. Previously asserted before the old deadline and could miss cancellation failure. |
| KEEP | §3.2: two threads in ONE project share one server, keyed by projectPath | Project-root selection makes subdirectory threads share the same real PID/endpoint. |
| KEEP | two projects get two servers | Distinct projects must bind distinct child processes/endpoints. |
| REWRITE | concurrent acquires for one project collapse onto a single start | Remove private binary-resolver call counter; actual concurrent handles must name one real child. |
| KEEP | a dead server is not reported as live by pool.list() | Actual child death removes stale diagnostic PID before another acquisition. |
| KEEP | the startup buffer is trimmed on a LINE boundary | Retained provider ready line survives bounded stdout framing; no pool option involved. |
| KEEP | a second stopAll waits for the first's kills: the host's two teardown calls both return only once the servers are gone | Repeated host teardown must await real child death. |
| KEEP | stopAll kills every server, refcount notwithstanding | Host shutdown closes an actively borrowed child. |

## Claude native history

Production caller: `claude/session.ts` supplies environment, cwd, host account directory and its process runner/runtime. Only `history.test.ts` supplies `workerPath`. Remove that override and unused worker/path/deadline constant exports, retaining the actual history worker path. Existing session transport options are owned by the Claude adapter agent and are not changed here.

Failure modes before retention: actual shipped worker truncates a transcript larger than the OS pipe buffer; empty/cut worker output becomes an unhelpful parser exception; the fork path omits that refusal handling. Source: managed-account history isolation/rollback protocol in GUI design §4.5 and documented POSIX write-flush regression.

Full bar for the following rewrites: (1) managed-account transcript/fork and process failure contracts independently require complete history or a meaningful failure; (2) wrong output blocks or corrupts caller-visible rewind; (3) fixed transcript records/count/last ID or deliberately malformed raw process bytes are independent oracles; (4) the success case invokes the shipped worker and installed SDK over an actual child pipe, failure cases replace only Node's process launch at its native boundary and still use real pipes; (5) history-reader/worker helper names and decomposition may change without invalidating the observations; (6) session fake transport cannot prove kernel-pipe completion, while these malformed-stream cases uniquely cover the reader's process boundary.

| Disposition | Original case | Failure / stronger owner |
| --- | --- | --- |
| REWRITE | reads a transcript far larger than the pipe buffer | Read a synthetic native transcript through the real shipped worker/SDK; the previous custom “flushing worker” could pass after the production worker regressed. Fixed 4,000 messages and final ID are the oracle. |
| REWRITE | a truncated payload is a named refusal, not a bare SyntaxError | Native process-launch fault supplies cut JSON; reader must return a non-SyntaxError carrying read-operation context. No production worker-path hook. |
| REWRITE | names an empty payload rather than throwing 'Unexpected end of JSON input' | Native process-launch fault returns no bytes; reader must identify failed history read, not succeed with empty history. |
| REWRITE | names unparsable output on the fork path too | Native process-launch fault gives invalid JSON to the fork; error identifies fork operation rather than exposing bare parser syntax. |

Risk: real subprocess tests still depend on local Node, the installed SDK and loopback sockets. Synthetic transcript records and credentials stay in throwaway temporary directories. No account/network provider calls occur. Validation: focused `opencode/server.test.ts` and `claude/history.test.ts`, then relevant OpenCode session/snapshot tests and Claude lifecycle tests only when touched seams require them. Root owns integrated gates.

Before removing final dead support: `stdout-write.ts` now has only its shipped worker caller. Its separate module existed so the old replacement-worker test could load the flush helper without the SDK. Inline the same awaited write callback into `history-worker.ts` and delete that wrapper module; the new real-worker regression protects the flush itself and the worker's exit behavior together.

Final review before editing: change two further pool cases from KEEP to REWRITE to remove a production-derived version oracle. Healthy adoption now arranges captured `1.18.5` and expects that literal; refusal names literal minimum `1.14.19`, independently required by GUI design §3.2 / §4.1. Their other bar justifications above still apply. This prevents raising/changing the production constant and mock peer together from silently changing the expected result.

## Completed validation and removed support

- Baseline: **22/22 passed** for `opencode/server.test.ts` plus `claude/history.test.ts`.
- Same focused pair after removing pool/history options: **22/22 passed**.
- After inlining the actual worker flush: `claude/history.test.ts`, `opencode/session.test.ts`, `opencode/snapshot-budget.test.ts`: **116/116 passed**.
- Final literal-version assertions: `opencode/server.test.ts`: **18/18 passed**.
- Commands run from `apps/daemon`: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test <the paths above prefixed with src/agent-host/adapters/>`. Logs are `/tmp/orquester-test-cleanup/pool-history-{baseline,final,integration}.log` and `pool-server-final.log`.
- Reviewed production/test diff and ran scoped `git diff --check`: passed. No broad gate was run; root owns those gates.

Removed pool password/timer/idle/hostname/fetch options, its unused password observer, helper-only constant/version-check exports, history worker-path override/constant exports and unused deadline re-export. Removed `claude/stdout-write.ts` after moving the unchanged awaited flush into its sole worker caller. The OpenCode session fake lost only the unused password property. No production caller's behavior/default was changed. Follow-up dispositions: **12 KEEP, 10 REWRITE** across these 22 existing cases; the prior ledger's deletions remain deleted.
