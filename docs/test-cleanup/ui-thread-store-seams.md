# UI thread-store dependency cleanup

Supplement to the per-case store audit in `ui_chat_state_stores.md` and its parent `ui_chat_state.md`; recorded before changing dependency setup. The owning agent is independently replacing reset-only production APIs with real page/module lifecycle.

## Callers and pre-edit decisions

`packages/ui/src/lib/agent-chat/store.ts` exposes `ThreadStoreDeps.newId`, `now`, `delay`, and `hostUnavailableRetries`. Production callers are `hooks.ts` and `components/command-palette/reveal-turn.ts`; both pass only `{ transport }`. The registry forwards the same dependency object internally. All explicit clock, ID, and sleep overrides occur in `store.test.ts`, `store.history.test.ts`, `store.retention.test.ts`, `store.fixwave.test.ts`, and `store.reload.test.ts`.

- DELETE all four test-only dependency options and fallback selection; preserve the existing production UUID/fallback generation, wall-clock timestamp, retry budget, and timeout/backoff values. The state owner already removed the unused retry-budget override.
- REWRITE ID setup/assertions to use actual generated IDs and compare caller-visible idempotency across repeated requests and reloads. Literal `id1`/`id2` values came from injected stubs and are not a contract. No crypto mock is necessary when a test needs only identity preservation; native UUIDs exercise the actual public request data.
- REWRITE elapsed-time cases using Node's native Date/setTimeout mock controls. Queue-expiry/reload expectations retain literal persisted timestamps and boundaries. Retry cases advance the actual backoff instead of replacing it with an immediately resolved promise.
- DELETE unused ID-prefix and clock-closure fixture helpers. All other per-case assertions/dispositions remain with the original audit.

## Independent contracts and full retention bar

Failure modes: a retry can mint a different receipt key and duplicate work; a lost response can leave a send pending forever; a generation teardown can cancel a send already accepted by the host; a reload can lose/reorder queued messages; a stale queue can send without renewed user intent; a visibility/pagehide timestamp can incorrectly renew an unseen queue.

1. Agent-chat spec §6.6 requires idempotent commands; §7.4 requires reload-safe outbox/queue behavior and bounded sends. Timestamped persisted outbox records and the transport command body are public storage/protocol contracts independent of the implementation.
2. Duplicate work, indefinitely disabled Send, dropped drafts, or stale automatic sends are recognizable user failures. Assertions observe emitted transport requests and restored queue/draft state.
3. Expected retry identity compares a previously emitted request ID with subsequent requests, not the production ID generator; queue age uses explicit fixture timestamps and expected hold state. The implementation can disagree by changing keys, thresholds, or visibility bookkeeping.
4. Actions, transport command bodies, persisted storage, and browser page lifecycle are stable seams. Native timer/Date controls substitute process time, without exposing internal timer callbacks.
5. Assertions survive generator replacement, helper extraction, and equivalent scheduling refactors; none require a particular random UUID, private delay function, or injected clock signature.
6. The store is the lowest owner of retry/outbox coordination across transport, storage, and page lifecycle. Pure queue/outbox parsing tests cannot detect lost receipts or generation races; the original owning audit removes duplicate lower-level cases.

Risk: native timers now include the real retry backoff rather than the old zero-delay override. Tests must await rejected request processing before advancing backoff; no production timing or retry count may change to make them pass.

Validation planned: only the five affected store test files with existing UI tsx/assert-ok/svg-loader/quiet-mock-timers imports. Root runs repository gates after concurrent UI lifecycle work settles.

## Per-case amendments

The original ledger retains every case disposition. The following cases additionally receive REWRITE of their timing/ID setup under the six-bar record above.

| Path | Case | Distinct failure retained |
| --- | --- | --- |
| `packages/ui/src/lib/agent-chat/store.test.ts` | mints a commandId per command and sends no optimistic row | mints a commandId per command and sends no optimistic row |
| `packages/ui/src/lib/agent-chat/store.test.ts` | setAccount posts the daemon-owned route with a minted commandId (§3.4) | setAccount posts the daemon-owned route with a minted commandId (§3.4) |
| `packages/ui/src/lib/agent-chat/store.test.ts` | setAccount retries HOST_UNAVAILABLE with the same id and banners a refusal | setAccount retries HOST_UNAVAILABLE with the same id and banners a refusal |
| `packages/ui/src/lib/agent-chat/store.test.ts` | posts `revert`, stays inert until the truncation lands, then hands the message back | posts `revert`, stays inert until the truncation lands, then hands the message back |
| `packages/ui/src/lib/agent-chat/store.test.ts` | retries a lost response with the SAME commandId | retries a lost response with the SAME commandId |
| `packages/ui/src/lib/agent-chat/store.test.ts` | a turn or an answer whose generation was destroyed mid-retry keeps retrying with the SAME commandId | a turn or an answer whose generation was destroyed mid-retry keeps retrying with the SAME commandId |
| `packages/ui/src/lib/agent-chat/store.test.ts` | an attempt that never answers times out and is retried with the SAME commandId, so no send reads Sending forever | an attempt that never answers times out and is retried with the SAME commandId, so no send reads Sending forever |
| `packages/ui/src/lib/agent-chat/store.reload.test.ts` | brings back a queue its page showed less than ten minutes ago as it was, to go out by itself | brings back a queue its page showed less than ten minutes ago as it was, to go out by itself |
| `packages/ui/src/lib/agent-chat/store.reload.test.ts` | holds a queue its page last showed more than ten minutes ago, in order, under its commandIds — nothing goes out by itself | holds a queue its page last showed more than ten minutes ago, in order, under its commandIds — nothing goes out by itself |
| `packages/ui/src/lib/agent-chat/store.reload.test.ts` | measures that absence from when the page last showed the queue, never from when a message was queued | measures that absence from when the page last showed the queue, never from when a message was queued |
| `packages/ui/src/lib/agent-chat/store.reload.test.ts` | stamps the queue as last shown when the page is hidden | stamps the queue as last shown when the page is hidden |
| `packages/ui/src/lib/agent-chat/store.reload.test.ts` | does not move that stamp at a teardown while the page is hidden | does not move that stamp at a teardown while the page is hidden |
| `packages/ui/src/lib/agent-chat/store.reload.test.ts` | stamps the queue as last shown on pagehide | stamps the queue as last shown on pagehide |
| `packages/ui/src/lib/agent-chat/store.reload.test.ts` | lets a queue kept in the page go on by itself when its thread comes back within ten minutes | lets a queue kept in the page go on by itself when its thread comes back within ten minutes |
| `packages/ui/src/lib/agent-chat/store.reload.test.ts` | holds a queue kept in the page when its thread comes back more than ten minutes later | holds a queue kept in the page when its thread comes back more than ten minutes later |
| `packages/ui/src/lib/agent-chat/store.reload.test.ts` | holds a failed re-post ahead of messages queued after it, even ones held because nobody saw them | holds a failed re-post ahead of messages queued after it, even ones held because nobody saw them |

The remaining cases in all five files only drop redundant dependency overrides; expected data and original KEEP/REWRITE decisions are unchanged. In the hidden/pagehide timestamp fixtures, teardown now occurs at minute 22 between hiding at minute 20 and reopening at minute 25; this removes their old contradictory minute-40 teardown followed by minute-25 reopen while preserving the independently expected five-minute absence.

## Completed validation

`cd packages/ui && node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/svg-loader.mjs --import ./test/quiet-mock-timers.mjs --test src/lib/agent-chat/store.test.ts src/lib/agent-chat/store.reload.test.ts src/lib/agent-chat/store.history.test.ts src/lib/agent-chat/store.retention.test.ts src/lib/agent-chat/store.fixwave.test.ts`: **133 passed, zero failures**, including all retry, queue, retention, history, and reload scenarios. An initial run exposed one leftover `enqueue` clock callback reference during editing; that reference now constructs the native timestamp, and the complete rerun passed.

Removed support: per-store ID factories, reload ID prefixes, custom clock closures, no-op delay overrides, and three now-empty lifecycle hooks. No new test cases or test-only production hooks were added. Scope `git diff --check` passes. Repository typecheck/test gates are coordinated by the root agent.

The two final visibility/pagehide timestamp fixture adjustments were rerun using `--test-name-pattern='stamps the queue as last shown' src/lib/agent-chat/store.reload.test.ts`: **2 passed**, 34 unrelated cases skipped.
