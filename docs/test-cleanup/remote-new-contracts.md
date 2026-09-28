# Incoming test contracts: origin/main 8dcbdc61

Status: completed cleanup of the two new incoming suites and their production owners after the coordinator signaled merge ready. The audit below was recorded before editing. Read from `git show origin/main:<path>`, including `index.ts` callers, API wire contracts, `grok-device-auth.ts` and its existing tests, and the account import owner.

## Grok device linking

Owner: `apps/daemon/src/grok-device-link.ts`; suite: `apps/daemon/src/grok-device-link.test.ts`.

Isolated owner failure modes: a granted authorization never becomes a managed account; rejected start leaves a phantom pending attempt or loses upstream failure status; duplicate start replaces an active attempt; cancel permits stale polling/import; terminal errors disappear or remain after retry; account persistence fails while the link falsely reports success.

Independent contracts: `packages/api/src/index.ts` `GrokDeviceLink`/`GrokDeviceLinkStatus` explicitly specify the public URL/code/expiry, linking state, lastError clearing and granted-link managed account result. `index.ts` wires start/conflict to public HTTP and broadcasts `changed`; actual RFC 8628 HTTP handling remains owned by `grok-device-auth.ts`. Account-home persistence/secrecy is required by AGENTS.md and the managed-account API.

Production callers: `index.ts` constructs `GrokDeviceLinkService` with only `importAccount: content => agentAccounts.importAccount({content})`, exposes status/start/cancel through `/api/agent-accounts/grok/link`, and forwards `changed` to the client. The new `deviceAuth`, `now`, and `sleep` options have no production caller and are test-only. Plan: remove them, use the existing real auth client plus Date/setTimeout and native fetch mocks. Keep importAccount, which is a production dependency. The owner-only `GrokDeviceLinkOptions`/`GrokLinkStartResult` type exports have no external references and can become private alongside the removed hooks.

| Disposition | Original case | Failure caught / plan / remaining coverage / risk |
| --- | --- | --- |
| REWRITE | a granted link imports the tokens as a managed grok account | Observe an actual managed account and its credential file via `AgentAccountsService` after a native mocked OAuth grant, then public idle state. Remove import callback-count and exact intermediate event-array assertions. The lower `grok-device-auth.test.ts` codec cases already own detailed auth-JSON field projection; retain only the durable grant-to-account outcome and public URL/code/expiry. Risk: removing this workflow owner would allow a successful OAuth grant to create no usable account. |
| REWRITE | a start failure is an upstream result carrying the status, and leaves nothing pending | Feed an HTTP 500 through the real auth client and assert the service's upstream code/status and idle state; remove fake deviceAuth and sleep injection. No lower codec test owns the service start-result/state mapping. Risk: phantom linking state or lost retryable upstream status. |
| REWRITE | a second start while one is pending is a conflict; cancel drops it locally | Use native mocked HTTP plus native fake timers; assert conflict, idempotent cancel, no token HTTP request and no managed account after the cancelled poll window advances. The fixture offers a successful grant so the negative result cannot pass merely because authorization remains pending. No other remaining test owns cancellation/duplicate-start coordination. Risk: an abandoned link continues into an account import or a second link replaces the first. |
| REWRITE | a failed verdict lands on lastError and a fresh attempt clears it | Drive a literal authorization-denied HTTP response through the client, assert caller-supplied error detail, start again and assert cleared lastError. Cancel teardown prevents an unobserved background poll. `GrokDeviceLinkStatus` defines this reset explicitly. Risk: stale/errorless Settings state. |
| REWRITE | a failed import is reported as the link's error | Cause the real account store's writes to fail using a local filesystem obstacle; observe public lastError and no managed account, without asserting exact operating-system prose. This is distinct from authorization failure and catches falsely successful linking when persistence fails. Risk: the UI reports a linked account whose credential was never saved. |

Full six-item justification for each REWRITE above:

1. Each row maps to the independently declared API/state/account-persistence contract above, not to private helper structure.
2. Its named failure is visible to Settings/API consumers or the caller trying to launch the linked managed account.
3. Fixed OAuth responses, explicit time, account-file bytes, error state and account absence are independent expectations. No oracle calls the production converter or computes an expected state using the owner.
4. Actions use public `start`/`status`/`cancel` and the public `changed` event; successful imports use the real account service, with only the external HTTP boundary mocked.
5. Native timers/fetch and public events survive helper renames, callback reshaping and equivalent internal scheduling. No exact event count/order or collaborator parameter-array assertion remains.
6. The real auth codec and account-store unit suites own their parsing/storage details; this owner uniquely covers device-flow coordination and resulting account availability. No route/UI duplicate is added.

Validation after merge: from `apps/daemon`, `pnpm exec node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test src/grok-device-link.test.ts src/grok-device-auth.test.ts`.

## One-time model-proxy retirement

Owner: `apps/daemon/src/model-proxy-retirement.ts`; suite: `apps/daemon/src/model-proxy-retirement.test.ts`.

Failure modes: obsolete proxy keeps rotating single-use refresh tokens; fresher credentials are lost or overwrite an even newer managed copy; unrelated credential fields disappear; generated secret-bearing launcher files survive; user-written wrappers or unrelated env files are deleted; a later boot replays migration; installations without a proxy are touched.

Independent source/callers: the incoming commit removes CLIProxyAPI/claudex/claudemix and `index.ts` invokes this migration before `agentAccounts.init()/startRefresher()`. Historical on-disk proxy state/auth formats and generated-wrapper marker are already deployed contracts. AGENTS.md requires preserving unknown persisted fields and secrets, and session ownership requires retiring the daemon-owned `orqsvc-cliproxy` session. `killServiceSession` and `managedCredentialPath` are both supplied by real `index.ts` callers; these are not test-only injection seams.

| Disposition | Original case | Exact protected result / stronger coverage / risk |
| --- | --- | --- |
| KEEP | the proxy's fresher tokens are handed back, its launcher files removed, and it runs once | Real temporary files prove newer Grok/Claude token pairs survive, newer managed Codex credentials remain, unrelated email/scopes survive, generated wrappers/env are removed while user-written/unrelated files remain, and later invocation neither stops the service again nor overwrites credentials. No other suite owns this removed-proxy migration; provider refresh tests do not perform it. Risk: account logout, credential/data loss or repeated destructive boot migration. Add only temporary-directory cleanup. |
| KEEP | no proxy directory: nothing happens | On a genuine empty appdir, assert no tmux kill request and no daemon directory created. Positive migration case cannot catch fresh-install mutation. Risk: touching unrelated daemon state or issuing destructive service control on installations without the retired feature. Add only temporary-directory cleanup. |

Full six-item justification for both KEEP cases:

1. Migration/storage/security contracts are independently anchored in deployed data and the incoming feature removal, with explicit startup ordering at the production caller.
2. Violations cause lost account authorization, deleted user files, credential-bearing dead launchers, or unintended service operations.
3. Literal existing token values, timestamps, legacy filenames and wrapper marker create the oracle; expected results do not reuse migration helpers. The newer Codex credential expected object is supplied input that must remain untouched.
4. `retireModelProxy` is the real boot migration entry point and filesystem bytes are durable observable output; the only spy observes the external tmux command seam supplied by production.
5. Changing parser/helper names, traversal strategy, private write methods or batching preserves these assertions when the migration contract is preserved.
6. This is the lowest owner of cross-store migration; existing account import/refresh tests cannot catch the selection and deletion rules. The no-proxy case is a separate safe-no-op input, not another replay of the positive migration.

Validation after merge: standard daemon node hooks with `--test src/model-proxy-retirement.test.ts`. No production changes planned for this owner; no dead fixture/export seam found in its four-file scope.

## Results

Implemented: 5 REWRITE, 2 KEEP, 0 DELETE; no new scenarios. The seven incoming baseline cases passed before edits. Removed link service `deviceAuth`/`now`/`sleep` options and forwarding wrappers, dead type exports, fake import/event-array harness support, and temporary-directory leaks. Retirement production behavior was unchanged.

From `apps/daemon`, `pnpm exec node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test src/grok-device-link.test.ts src/grok-device-auth.test.ts src/model-proxy-retirement.test.ts` passed all 9 tests, with zero failures, cancellations or skips. Focused `git diff --check` passed and the complete source/test diff was reviewed. Root owns typecheck and final repository gates.

## Post-rewrite support reference check

Before editing the support owner, whole-repository references showed `GrokDevicePrompt`, `GrokDeviceStart`, `GrokDevicePoll` and `GrokDeviceAuth` exported only for the removed injection path/residual retired proxy tests. The remote-integration owner confirmed those proxy tests are deleted and authorized privatizing the four types in `grok-device-auth.ts`. Their internal protocol definitions and the production-called token/client exports remain unchanged.
