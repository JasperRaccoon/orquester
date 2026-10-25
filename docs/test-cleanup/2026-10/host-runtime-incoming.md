# Incoming host runtime audit: origin/main 7feff9eb

Reviewed 1df3c13f..7feff9eb. origin/main 7feff9eb was integrated in merge e0e6270d, and the prepared cleanup is now applied to the merged stream.test.ts. The root has completed the integrated changed-file gate, full typechecks, build, full stream-file validation and all three intended stream negative controls. The final full repository test run is still active; this report does not claim its outcome.

## Scope and count

The only changes under host runtime/server/orchestration/session-tools/store/index are commit 09edea2274411a26d672697229c22a4170bb2d56, server/stream.ts and server/stream.test.ts. It adds ONE named test, not two. No new storage/orchestration/session-tool cases were found. Other incoming agent-host changes are the Claude settings/launch and box remote-child files assigned to their separate owners. The existing 15 stream declarations in the original ledger remain unchanged by the incoming commit.

## New test disposition

Path: apps/daemon/src/agent-host/server/stream.test.ts:320 at origin/main.
Exact name: writes a snapshot larger than the budget whole: the budget bounds the live backlog, not the read.
Disposition: REWRITE (retain real contract; replace invalid extra-field fixture and strengthen whole-payload oracle).

1. Independent contract: historical regression documented in 09edea22: a real 9.4 MB subagent snapshot caused the stream to emit its live-buffer error before the first row, then reconnect forever. The public snapshot-or-replay NDJSON stream must deliver that snapshot and then synchronized/live frames. The independently documented 8 MiB live-backlog rule is in docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §6.3 (around lines3375 and3572) and packages/api/src/agent-chat/wire.ts:1281. The historical fix narrows that rule to live backlog; preserving the observed read is the caller contract.
2. Real failure: reintroducing charge of the initial snapshot closes the stream with budget before snapshot/synchronized/live event delivery. A truncating fix also violates snapshot data conservation; the rewritten exact wire-payload comparison detects that. The existing terminal live-overflow assertion after the large snapshot ensures a fix cannot permanently exempt subsequent live frames after an oversize read.
3. Independent oracle: literal three-frame kind order [snapshot,synchronized,event], no close before live overflow, and later close reason [budget]. The rewrite adds exact parsed snapshot equality to the fixed fixture, whose valid message text exceeds the documented literal8MiB. The expected snapshot is the input data from the read boundary, not a production budget/serializer projection. fakeResponse records writes/return backpressure only; it does not decide charging, serialization, ordering or closure.
4. Stable seam: exported createThreadStream with a read dependency returning the public ThreadSnapshotPayload and a ServerResponse transport boundary. Assertions observe emitted protocol data and close result, never writeFrame/charge private call shape.
5. Refactor resistance: renaming or restructuring private write helpers, budget tracking or queue implementation preserves the expected parsed wire snapshot, frame order and closure semantics. Replacing the incoming unknown `padding` with a valid message prevents a correct schema-filtering serializer from silently turning the oversize regression fixture into a small one.
6. Unique protection: the adjacent generic overflow/drain cases begin with an empty read, and HTTP stream tests use small snapshots. They protect slow-client budgets but cannot catch an oversized initial read reconnect loop or a fix that exempts all live frames specifically after a large read. UI/client tests cannot own the host writer's charging boundary. Keep the post-read live-overflow assertion despite superficial overlap, because it covers this state transition.

Incoming test defects before cleanup: synthetic padding is not a public snapshot field and can disappear during a behavior-preserving schema serializer refactor, making the test vacuous; only frame kinds are checked, so dropping or truncating all snapshot content could pass. A valid public message plus exact payload assertion repairs both. The production implementation itself matches the documented historical fix: only read frames bypass charging; synchronized, pre-read live-buffer events, history progress, heartbeats and later live/agent rows retain charging. No production change proposed.

## Applied cleanup

The applied change in apps/daemon/src/agent-host/server/stream.test.ts removes the new production-limit import, uses the documented literal8MiB in a typed valid message fixture, and adds an exact parsed snapshot assertion. No new case, helper, infrastructure, production seam, sleep or real timer is added. This is +6 test LOC relative to incoming code (34 new lines ->40). This cost buys a stable public fixture and the actual whole-snapshot oracle. No runtime/speed claim is made; timer virtualization already avoids wall-time waits. Live-overflow allocation is intentionally retained to protect charging following the exempt snapshot.

## Completed validation and negative controls

The integrated gate's passed sections are recorded in /tmp/orquester-test-audit/integrated-gates.log:

- `pnpm check:changed --no-cache --base 0e61cd5dfed987e9bcbafe097e2582f90586ef4f`: typechecks passed in 20.7 s, 16 daemon test files passed in 36.6 s, and 3 UI test files passed in 14.9 s.
- `pnpm check`: all workspace typechecks passed.
- `TSX_DISABLE_CACHE=1 pnpm build`: the workspace build passed, including web and desktop emitted assets.

`python3 /tmp/orquester-test-audit/validate-incoming-stream.py` completed successfully with Node v24.22.1. Its positive command, from apps/daemon, was `TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=45000 --test-reporter=/tmp/orquester-test-audit/incoming-stream-validation/assertion-reporter.mjs src/agent-host/server/stream.test.ts`. All 16 tests passed (zero failed, cancelled or skipped); wall time was 3.030 s. The oversized-snapshot test body took 253.020 ms. These are focused observations, not a baseline comparison or a claimed suite speedup.

The three independent in-memory mutations were isolated to the new named case using the native --test-name-pattern filter. Each returned nonzero for its specific ERR_ASSERTION; no guard timeout counted as a valid result:

| Mutation | Intended failure observed | Result | Wall time |
| --- | --- | --- | --- |
| Charge the initial read again | Early close reasons were [budget], expected []; the snapshot must not cut its own connection. | KILLED_BY_INTENDED_ASSERTION | 1.469 s |
| Exempt subsequent live events from charging | Final close reasons were [], expected [budget]; initial snapshot delivery still passed. | KILLED_BY_INTENDED_ASSERTION | 1.972 s |
| Remove the initial snapshot message before serialization | Parsed wire snapshot had zero items, expected one large message with 8,389,632 text bytes; matching frame kinds alone could not pass. | KILLED_BY_INTENDED_ASSERTION | 1.971 s |

The module loader preserved original import resolution and never wrote repository source. The validator's finally check confirmed exact source bytes unchanged, with identical before/after SHA256 for both stream.ts and stream.test.ts. Evidence: /tmp/orquester-test-audit/incoming-stream-validation/results.json and the per-run JSONL/stderr logs in that directory. The full file also exercised the adjacent overflow/drain owners; the negative controls independently distinguish oversized-read delivery, later live-budget enforcement and whole-snapshot content preservation.

The incoming delta is one REWRITE declaration, zero new or deleted cases from cleanup, and +6 test LOC compared with incoming code. It is additional to the original 743-declaration ledger. The root owns final full-suite results, overall timing comparison, count reconciliation and git delivery.
