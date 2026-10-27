# Incoming capacity-error adapter tests

Exact incoming reference: `923b3a51b594ef668483a5bd320af41187899e34`; introduced by `2034d20dbc32b3de627097778a12abd2f7dd43fb` (`feat(agent-chat): retry chats stopped on a provider's capacity error`). The frozen remote tree, changed cases, production normalizers, generated protocol type, SDK declarations and canonical failure/notice contracts were read before edits.

Scope: exactly two incoming declarations. Dispositions: **one REWRITE, one KEEP**; no declaration removed or added. One unused setup call was removed (**−1 test LOC**); production, fixtures, helpers, dependencies and configuration are unchanged. Existing cases retain their original audits.

| Incoming923b path and line | Test | Disposition | Implemented result |
| --- | --- | --- |
| `apps/daemon/src/agent-host/adapters/claude/normalize.test.ts:3330` | a 529 result is overloaded, not the account's failure | REWRITE | Keep the raw HTTP529-to-overloaded regression, removing the unnecessary preceding assistantError(overloaded) message. The documented success-subtype529 result must carry the reason by itself; arranging both indicators could mask a bug that wrongly requires the assistant marker. No production behavior change or replacement case. |
| `apps/daemon/src/agent-host/adapters/codex/replay.test.ts:451` | a terminal serverOverloaded ("Selected model is at capacity") is overloaded, never while retrying | KEEP | Unique raw Codex serverOverloaded mapping and provider-retry suppression: the same protocol code must carry no actionable reason while willRetry=true, then overloaded when terminal. Existing usage/auth tests and normalized notice/recovery tests do not own this mapping. |

## apps/daemon/src/agent-host/adapters/claude/normalize.test.ts

Test: **a 529 result is overloaded, not the account's failure**.

Independent sources:
- `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md:1441`: Repeated529 overloads arrive as success-subtype results carrying api_error_status529.
- `2034d20dbc32b3de627097778a12abd2f7dd43fb`: Claude529 is stamped reason overloaded, retried without account cooldown/switch, never account failover.
- `packages/api/src/agent-chat/runtime-events.ts:995`: RuntimeFailureReason overload is provider-capacity failure, distinct from account usage_limit/auth.

Six behavioral requirements:
- **Independent contract:** Raw success-subtype api_error_status529 emits terminal runtime.error reason overloaded, no resetsAt; source is documented protocol trap plus capacity-retry feature contract.
- **Real regression:** A capacity-stopped Claude chat gets no short retry or is mistaken for account quota/auth, causing wrong cooldown or account switch.
- **Independent oracle:** Literal [[runtime.error,overloaded,undefined]] is independently specified; expected fields are not produced by calling classifier under test. Revised setup supplies only raw529 result.
- **Stable seam:** Production-used ClaudeNormalizer.handleMessage receives SDK wire message and returns canonical runtime error events.
- **Refactor resistance:** No source search, private counter, collaborator shape or exact prose; normalizer implementation may change while SDK/canonical error boundary stays.
- **Unique protection:** API notice/recovery tests start with already-normalized overloaded activity and cannot catch a lost provider529 mapping. Existing Claude auth/quota cases concern different codes; generic result-error rendering does not assert the new structured overload reason.

Production callers: Claude session feeds SDK frames into ClaudeNormalizer; ingestion stores runtime reason; overloadOfActivity/usageLimitNoticeOf and daemon limit recovery consume it.

Surviving oracle: `failures(make().handleMessage(failedResult(529))) equals [["runtime.error","overloaded",undefined]].`

Cost: In-memory normalizer case, no process/network/database startup; incoming baseline timing not yet available.

Risk: low: remove unused setup, preserve assertion and case identity.

## apps/daemon/src/agent-host/adapters/codex/replay.test.ts

Test: **a terminal serverOverloaded ("Selected model is at capacity") is overloaded, never while retrying**.

Independent sources:
- `apps/daemon/src/agent-host/adapters/codex/_generated/protocol/v2/CodexErrorInfo.ts:12`: Generated provider protocol declares serverOverloaded as its own code, distinct from usageLimitExceeded/rateLimitExceeded/unauthorized.
- `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §10`: Retryable provider errors are warnings; terminal errors are surfaced. A retry which may succeed is not acted upon as a stopped chat.
- `2034d20dbc32b3de627097778a12abd2f7dd43fb`: Codex Selected model is at capacity/serverOverloaded becomes overloaded and retries shortly without account cooldown/switch.
- `packages/api/src/agent-chat/runtime-events.ts:995`: Canonical overload reason identifies provider capacity rather than account failure.

Six behavioral requirements:
- **Independent contract:** Raw serverOverloaded becomes canonical overloaded only when provider marks the failure terminal; in-flight provider retry must not trigger host capacity recovery.
- **Real regression:** Capacity-stopped Codex chat never retries, is switched/cooled as a quota account, or host recovery races an in-flight provider retry.
- **Independent oracle:** Literal [undefined,"overloaded"] for explicit willRetry true/false inputs; no classifier output or production constants calculate expected values. Helper message still mentions429, usefully checking structured codexErrorInfo wins over message wording.
- **Stable seam:** Production-used CodexNormaliser.notification consumes raw generated-protocol error frames; case inspects canonical error/warning payload reason.
- **Refactor resistance:** No private failureReasonOf import, call-count assertion, implementation inventory, snapshot or exact error prose; internal dispatch/classifier refactors preserve protocol inputs and emitted reason.
- **Unique protection:** Existing generic retry case uses usageLimitExceeded and cannot catch missing serverOverloaded classification or code-specific premature overload annotation. API/daemon retry tests use normalized activity; they cannot replace provider-code mapping. Both statuses are one cheap scenario.

Production callers: Codex session forwards app-server notifications to normalizer; ingestion and overloadOfActivity/usageLimitNoticeOf consume reason; recovery/workflows distinguish it from account failures.

Surviving oracle: `Unchanged: payload reason list [undefined,"overloaded"].`

Cost: Two in-memory error notifications; no spawned peer, fixture read, server, clock wait or duplicated end-to-end workflow. Incoming baseline timing not yet available.

Risk: none: retained cheap regression.

## Validation status

No tests were started while the root incoming-reference suite holds the test slot. Requested focused command after release:

```sh
cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-concurrency=4 --test-timeout=600000 src/agent-host/adapters/claude/normalize.test.ts src/agent-host/adapters/codex/replay.test.ts
```

Root owns the final typecheck/full-suite gates, merge validation, commit and push. No production seam or test helper became unused by removing the one preceding message: `assistantError` remains used by the adjacent auth/quota cases. No isolated timing improvement is claimed for deleting one inexpensive normalization call.
