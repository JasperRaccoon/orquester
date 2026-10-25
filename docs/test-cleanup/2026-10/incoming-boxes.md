# Incoming boxes audit after remote fetch

Compared local starting `HEAD` (`bff9af…`, before root's cleanup commit) with the fetched `origin/main` containing `c61aad62` and `1df3c13f`. Scope: `boxes/broker/{broker,refresh-scheduling}.test.ts`, `boxes/sync/rules.test.ts`, their changed production owners, shared `agent-account-refresh.ts`/`agent-accounts.ts`, and the updated CLI spike evidence.

There are **9 incoming added/modified named declarations: KEEP 6, REWRITE 3**. Six previous declarations are superseded upstream and recorded below. No incoming declaration is deleted wholesale: each owns a distinct renewal, cancellation, filesystem wakeup, or configuration-direction contract. The duplicate `invalid_grant` race inside one integration is removed; the public account service owns that race.

Prepared `/tmp/orquester-test-audit/incoming-boxes/cleanup.patch` against the remote versions. It changes two test files, **40 added / 21 removed lines (net +19)**, adds no test declarations or production seams, and changes no production behavior. The extra lines establish explicit native-registration, initial-read and actual-notification receipts; the overall local boxes cleanup remains net negative. The patch does not restore the two old broker declarations already deleted by the local cleanup; it applied after the normal merge.

**Integration state:** the first audit was prepared in temporary files without repository mutations; root subsequently merged the remote production changes in `e0e6270d` and applied its cleanup patch. The additional authorized OOM test edits described below are now applied. `git apply --check cleanup.patch` passed against temporary original remote files before integration. Root has now passed the integrated changed-file gate (16 daemon and 3 UI files), full workspace typecheck, build and the native-watch controls recorded below. Final `pnpm test` is running and the Go race check remains pending. No speedup is claimed.

## Independent contracts and production ownership

The incoming renewal policy is supported by `docs/superpowers/specs/2026-10-19-ephemeral-ai-vms-spikes.md`, section “When to refresh a host-held account”, and its CLI-specific evidence: Codex 0.163.0 reloads `auth.json` before proactive refresh and unauthorized recovery; Grok 1.0.67 adopts a changed valid access token before spending its refresh token. Claude's native refresh-lock directories remain the exclusion boundary. These observations support direct daemon renewal above ten minutes, returning a usable unrejected token between five and ten minutes, direct renewal with no usable token, and waiting while Claude's CLI actively owns the lock.

The public `AgentTokenBroker.getToken` contract owns request authorization, usable-token selection, direct-renewal decisions, provider rejection, error mapping and cancellation. `AgentAccountsService.refreshNow` owns OAuth refresh/persistence and adoption of credentials rotated by another process. `nodeCredentialFiles` owns the actual rename-aware filesystem watch. The sync rule's `SyncRule.hostOnly` contract explicitly identifies paths whose box changes are neither collected nor undone; `BoxConfigSync` consumes that boundary. There is no existing Codex-specific plugin-direction owner in `config-sync.test.ts`; its marketplace case is Claude-specific.

The public account-service race case is retained by the accounts owner (confirmed directly): `an invalid_grant for a refresh token a host CLI already rotated is that CLI's refresh, not a login to redo`. It checks both successful adoption and the contrasting genuine invalid grant through `refreshNow`, actual files and `needsReauth`, without the broker's unrelated setup.

## Every incoming declaration

### `apps/daemon/src/boxes/broker/broker.test.ts`

**`a host-local Codex or Grok holder: refreshed above the floor; below it a usable token goes out, and with none the daemon refreshes` — KEEP**

1. Independent contract: the updated spike evidence's explicit Codex/Grok adoption and five/ten-minute renewal policy.
2. Real failure: a held box request incorrectly waits for its host CLI, returns a nearly expired token, or spends a refresh token in the below-floor usable-token window.
3. Independent oracle: literal 37-, 8-, 4-minute and expired input lifetimes; expected old lifetime versus the scripted fresh eight-hour credential. These outcomes distinguish a direct renewal from returning the old token. The fake dependency provides credentials; it does not choose the broker's renewal policy.
4. Stable seam: `getToken`, native credential-file formats and the account service's public `refreshNow(..., {allowHeld})` option.
5. Refactor resistance: only grants and semantic refresh permission are asserted; no broker function names, branch layout, or source strings are inspected.
6. Unique protection: covers the different Codex/Grok credential formats and holder behavior over four semantic states. The real integration below covers the shared permission/service connection, while the account refresher's hourly selector has a separate trigger. The account-service race test cannot detect wrong broker fallback selection.

**`a host-local Claude holder: refreshed above the floor or with nothing usable left, never while its CLI holds the refresh lock` — REWRITE**

1. Independent contract: the same documented policy plus the native Claude refresh-lock and stale-lock rules.
2. Real failure: returning a four-minute token, refreshing while a live CLI owns the lock, failing to adopt a rewritten credential, or letting a stale lock block renewal.
3. Independent oracle: patch uses literal **9/4/3 minutes**, replacing fixture lifetimes computed from production `HELD_REFRESH_FLOOR_MS`/`COOLDOWN_MIN_LIFE_MS`. Expected literal old/new/CLI tokens and no-refresh outcomes can now disagree with accidentally changed production thresholds. A too-short intermediate rewrite must not release the waiting request.
4. Stable seam: public `getToken`, credential file changes, native lock-path/mtime boundary and public account-service renewal permission.
5. Refactor resistance: names of internal branches and private collaborators are absent; changing production timing constants can no longer move the fixture with the implementation. Fake watch counts synchronize dependency events and verify the request releases that OS-boundary subscription.
6. Unique protection: Claude-specific lock exclusion and stale-lock recovery are absent from Codex/Grok. The real-file case verifies native rename delivery, while this case covers the distinct usable/short/stale-lock decision table without repeated filesystem setup.

**`a waiting request whose holder's session ends: the daemon refreshes then` — KEEP**

1. Independent contract: a request waiting for an active CLI may renew once that session stops holding the account.
2. Real failure: the box request remains blocked after the holder exits, or renews before holder release.
3. Independent oracle: initial literal two-minute credential and fresh Claude lock; no initial refresh; externally delivered session-change notification after the holder disappears must produce the literal fresh token with ordinary renewal permission.
4. Stable seam: `getToken` and its documented session-lifecycle/holder dependencies.
5. Refactor resistance: observes permission and final grant, rather than any private broker waiting mechanism.
6. Unique protection: filesystem rewrites and AbortSignal cancellation do not exercise holder-exit wakeup. The real account service cannot synthesize that router event by itself.

**`a wait ends with TOKEN_WAIT_TIMEOUT when the request's signal aborts` — KEEP (modified scenario setup)**

1. Independent contract: request cancellation returns public error code `TOKEN_WAIT_TIMEOUT`, HTTP status 504, and releases the credential watch.
2. Real failure: cancelled requests hang, return a different error, leak their watch, or renew after cancellation.
3. Independent oracle: a literal fresh Claude lock plus one-minute token forces the independently specified waiting state; the explicit AbortController then requires `AgentTokenError`, exact code/status, no refresh and released watch.
4. Stable seam: public request, AbortSignal, public error contract and file-watch resource boundary.
5. Refactor resistance: no elapsed-time assertion, private timer, or exact prose is required. Changing from the former Codex setup follows the new supported policy.
6. Unique protection: session exit and credential rewrites complete successfully and cannot detect incorrect cancellation/error handling.

**`a rejected token of a host-held account is renewed by the daemon, above the floor or below it` — KEEP**

1. Independent contract: provider-refused access tokens are unusable even before their advertised expiry; held-account renewal is permitted when no usable token remains.
2. Real failure: repeatedly handing out a refused token or waiting indefinitely for a held Codex/Grok CLI despite its reload capability.
3. Independent oracle: literal REFUSED markers and independent five-hour/eight-minute lifetimes; the result must be a different/fixed fresh token for all three native credential formats. Public renewal permission must be enabled.
4. Stable seam: `getToken` with the documented `rejectedAccessToken` request field and account-service renewal option.
5. Refactor resistance: tokens are compared through grant data; no implementation source or private function is inspected.
6. Unique protection: normal expiry tests cannot detect treating a long-lived but provider-rejected credential as usable. Concurrent rejection tests exercise coalescing with no host-local holder; the locked Claude case deliberately forbids direct renewal.

**`a rejected token of a held Claude account whose CLI holds the refresh lock: the request waits for that CLI's rewrite` — KEEP**

1. Independent contract: a live Claude refresh lock forbids parallel spending of its refresh token even when the old access token was explicitly rejected.
2. Real failure: returning the refused credential again or issuing a competing refresh while Claude is renewing it.
3. Independent oracle: the credential is still nominally valid for five hours but has a literal rejected marker; the promise must remain unsettled without daemon refresh, and a separate CLI credential rewrite must return the literal CLI token.
4. Stable seam: public rejection request, native lock lifetime and credential-change notification.
5. Refactor resistance: assertions concern grants and renewal exclusion; implementation variables/call order are not the oracle.
6. Unique protection: the ordinary lock scenario uses a nearly spent credential. That cannot detect an erroneous early return of an unexpired rejected token before the lock rule is evaluated.

### `apps/daemon/src/boxes/broker/refresh-scheduling.test.ts`

**`a held Claude account whose CLI holds the refresh lock, over real files: the CLI's rename-replace ends the wait` — REWRITE**

1. Independent contract: native CLI credential replacement must wake a waiting box request without an OAuth request while the CLI owns its refresh lock.
2. Real failure: watching the old credential inode, never observing an atomic replacement, or spending the refresh token despite the active lock.
3. Independent oracle: real account home, native lock directory, initial literal OLD token, actual atomic replacement with a distinct CLI token, and zero real refresh-boundary requests. The patch waits for both return from the real native watch-registration call and capture of the first real credential read before writing the replacement, then separately awaits a real native watch notification. The old `setImmediate` could write before the broker's first read and pass without any watch wakeup.
4. Stable seam: `getToken`, real `nodeCredentialFiles`, filesystem atomic rename, and real account service. Wrappers delegate the existing filesystem read/watch dependencies unchanged, signal registration only after the real fs.watch call returns, and signal notification only from its actual callback after forwarding the broker's onChange; there is no production hook or mock supplying bytes/events.
5. Refactor resistance: no assertion pins callback counts, private waiting internals, scheduling turns or elapsed time. The explicit registration and old-read receipts precede replacement, and completion requires an actual native notification; a broker that merely re-reads new bytes without a native event cannot satisfy that receipt.
6. Unique protection: broker in-memory tests cannot detect OS watch-on-inode mistakes. The account service's atomic-write tests protect the writer, while this protects the waiting reader's native wakeup. The Codex integration below renews directly and never waits for a file event.

**`a held Codex account with nothing usable left: the daemon refreshes; an invalid_grant lost to the host CLI's own refresh reads as that refresh` — REWRITE**

Final name: `a held Codex account with nothing usable left is renewed through the real account service`.

1. Independent contract: a box whose held Codex token is expired must receive a usable renewal through the real account service, with the host holder still present.
2. Real failure: the broker requests renewal without allowing the held account, the real service returns `held`, or the fresh grant is not read back from persisted credentials.
3. Independent oracle: literal expired input credential; fixed OAuth response expiring ten days later; returned exact expiry and one request. The patch uses a successful OAuth response instead of simulating the already-owned sibling-refresh race.
4. Stable seam: public `getToken` → public account service → OAuth response and actual credential persistence, with the real session router's host-local account set.
5. Refactor resistance: no private permission-call inventory is needed; omitting the required semantic permission leaves the real service refusing to renew. HTTP response data and returned grant provide the oracle.
6. Unique protection: broker unit dependency doubles do not independently enforce the real service's holder refusal; the account-service test alone cannot detect a broker that omitted its required permission. The duplicated invalid-grant race is retained at its lowest stable owner in `agent-accounts.test.ts`, as confirmed with the accounts owner.

### `apps/daemon/src/boxes/sync/rules.test.ts`

**`Codex's plugins/ is its own marketplace store: host → box only, a box's downloads are never collected` — KEEP**

1. Independent contract: CLI-managed marketplace store contents remain local on the box; the host can still push its plugins, and enabling configuration/custom skills remain two-way. `SyncRule.hostOnly` documents this directionality and `BoxConfigSync` consumes it when collecting changes and reconciling deletions.
2. Real failure: Codex's box-downloaded plugin scripts become host approval changes, host plugins stop being pushed, or an overly broad rule also suppresses config/custom-skill collection.
3. Independent oracle: literal native `plugins/cache/...`, `plugins/.remote-plugin-install-staging/...`, `plugins`, `config.toml` and `skills/...` path examples with fixed true/false outcomes; expected values are not computed from the new prefix predicate.
4. Stable seam: public sync-rule configuration boundary, observed through `isSyncedRel`/`hostOnly` for named native CLI paths.
5. Refactor resistance: identifier-only renames or replacing the prefix implementation preserve the same native path/data semantics; no source string, private function identity or export inventory is checked.
6. Unique protection: existing Claude marketplace direction tests have a different rule and paths. The generic two-way/prepared rule tests do not exercise Codex's plugin exception or its required two-way controls. A duplicate full host/box workflow is unnecessary for this small configuration decision.

## Superseded upstream declarations

These six old declarations are removed by the incoming feature update, rather than by the prepared cleanup patch. The local baseline ledger is historical; the incoming rows above supersede the old policy where it changed.

| Path | Exact old name | Disposition and surviving contract |
|---|---|---|
| `boxes/broker/broker.test.ts` | `a host-local Codex holder: the request waits for that CLI's rewrite and never refreshes` | DELETE as obsolete: verified Codex reload behavior now permits direct renewal; new held Codex/Grok matrix owns the supported policy. |
| `boxes/broker/broker.test.ts` | `a host-local holder whose session ends: the daemon refreshes then` | CONSOLIDATE into the renamed waiting Claude-holder case. The old Grok scenario no longer waits under the supported policy. |
| `boxes/broker/broker.test.ts` | `a host-local Claude holder: refreshed directly above the floor, waited for below it or while its CLI holds the refresh lock` | REWRITE by upstream: new Claude case distinguishes usable below-floor return, spent-token renewal and active-lock wait. Old unconditional below-floor wait is obsolete. |
| `boxes/broker/broker.test.ts` | `a rejected token of a host-held Codex account: the request waits for that CLI's rewrite` | DELETE as obsolete: the refused-token matrix now requires direct renewal for this CLI. |
| `boxes/broker/broker.test.ts` | `a rejected token of a host-held Claude account above the floor is refreshed directly` | CONSOLIDATE into the new three-agent refused-token matrix; a separate locked-Claude owner retains its distinct exclusion. |
| `boxes/broker/refresh-scheduling.test.ts` | `a host-local holder over real files: the CLI's rename-replace of auth.json ends the wait` | REWRITE by upstream to native Claude lock/credential replacement. Codex no longer waits with an expired token; actual rename wakeup remains uniquely protected. |

## Validation after integration

Root executed the three-file positive gate from `apps/daemon` with `TSX_DISABLE_CACHE=1`:

```sh
node --import tsx --test --test-reporter=tap --test-timeout=600000 --test-concurrency=4 /var/lib/orquester/workspaces/jaspersito/orquester/apps/daemon/src/boxes/broker/broker.test.ts /var/lib/orquester/workspaces/jaspersito/orquester/apps/daemon/src/boxes/broker/refresh-scheduling.test.ts /var/lib/orquester/workspaces/jaspersito/orquester/apps/daemon/src/boxes/sync/rules.test.ts
```

**Passed: 33/33 tests, zero failures/skips, measured process wall time 3.421 seconds.** The subsequent isolated positive and suppressed-native-dispatch control also passed their validator; exact results appear below. The mutation was detected by its intended `ERR_ASSERTION`, and all four protected source hashes remained unchanged. The account-service race owner also belongs to root's changed-file gate. Final full-suite and Go race results remain pending.

## Native watch scheduling review

The production `CredentialFiles.watch(path, onChange)` interface returns an unsubscribe function synchronously. `nodeCredentialFiles` calls native `fs.watch(dirname(path), ...)` synchronously, filters the callback to the requested credential basename, and returns after the listener is registered. The current broker calls this port before its first credential read and arms its ChangeLatch before reading. The revised test makes that registration boundary an explicit receipt, rather than relying on source ordering as an implicit property of the first-read receipt.

The sequence is: delegate real registration → capture old bytes → receive both receipts → atomically replace the credential → receive the actual filtered native callback → obtain the CLI grant without an OAuth request. Neither registration nor notification is synthesized. `nativeChange` cannot resolve from an unrelated account-service result or broker re-read. The isolated native-dispatch suppression control below demonstrated the missing-notification failure through an explicit assertion, after both positive setup runs passed.


# Incoming OOM-survival audit

Compared `1df3c13f..7feff9eb`, specifically `0dfb6349` and its production owners. This adds **7 incoming named tests: KEEP 2, REWRITE 4, CONSOLIDATE 1 (removed standalone)**. One existing reconnect test is the surviving CONSOLIDATE owner and is recorded separately below. The remote-child, hub and toolchain changes remove **one declaration, two real Node child starts, and 7 test LOC**. No comparable before/after measurement was collected for these incoming cases, so no speedup is claimed. The Go resource-policy test is retained unchanged. `DETACHED_BUFFER_BYTES` is now private after a fresh repository-wide caller search found only same-file production references after removing its test import. Production values and behavior are unchanged.

Owned source edits: `apps/daemon/src/agent-host/boxes/{remote-child.test.ts,remote-child.ts}`, `apps/daemon/src/boxes/hub/agent.integration.test.ts`, and `apps/daemon/src/boxes/service/toolchain.test.ts`. Cleanup patch copy: `/tmp/orquester-test-audit/incoming-oom/cleanup.patch` (three test files; the separately authorized one-line export cleanup followed it). Source edits are frozen. Scoped `git diff --check` passed. Root subsequently passed the changed-file/runtime and build/typecheck gates recorded below.

The independent historical contract is the OOM incident recorded in commit `0dfb6349`: exhausting one box process's memory must not stop the whole agent service, missed output must not end every chat, and an unobserved process end must never be reported as a clean exit. Native systemd configuration, Linux swap/fstab formats, the shared `BoxExecOptions` wire contract and `ProviderChild` exit result establish stable boundaries. Actual kernel OOM and host swap activation are not induced by these tests; that limitation does not turn native configuration verification into a kernel-level experiment.

## Every incoming OOM declaration

### `apps/box-agent/internal/agent/service_linux_test.go`

**`TestOOMPolicyDropInIsWrittenOnce` — KEEP**

1. Independent contract: systemd's native `[Service]` `OOMPolicy=continue` setting is the required resource-policy change identified by the independently described OOM incident. Repeated agent starts should not request unnecessary policy reloads.
2. Real failure: a misspelled, omitted or wrong OOM policy leaves systemd stopping all agent chats when one cgroup process is killed for memory; repeatedly rewriting unchanged policy causes unnecessary reloads.
3. Independent oracle: reads the actual temporary `oom-policy.conf` file and requires literal native section/key/value bytes, without deriving expected content from `oomPolicyDropIn`. A repeated unchanged write returns the unchanged result consumed by the production caller to skip reload.
4. Stable seam: actual systemd drop-in filesystem artifact and the writer's changed/not-changed result. The real `ProtectService` production caller uses this writer; its path parameter redirects the native artifact safely into a temporary directory.
5. Refactor resistance: no production identifier, source grep, generated comment prose, complete file snapshot or helper-call count is the expected value. Native key/value bytes remain required across implementation changes.
6. Unique protection: neither daemon process-loss mapping nor swap installation can detect a wrong systemd resource-policy file. Existing needrestart tests guard a different native configuration consumer. This test does not claim that a live systemd reload or actual OOM event was executed.

### `apps/daemon/src/boxes/service/toolchain.test.ts`

**`a box without swap gets a swapfile, listed in fstab once; a box with swap is left alone` — REWRITE**

1. Independent contract: the documented setup policy creates private swap for a box without any, activates it, persists its native fstab entry and leaves existing swap alone.
2. Real failure: wrong allocation size, missing formatting/activation, a world-readable swap file, omitted reboot persistence or reallocation on an already configured box.
3. Independent oracle: real POSIX execution, literal native allocation/format/activation argv, actual swapfile mode `0600`, actual fstab line and one allocation across two runs. Removed exact “Added …”/“already on” prose; status queries are filtered by native operation rather than assuming the first captured call is always one specific query.
4. Stable seam: generated public setup script executed by `/bin/sh`, native command interfaces and resulting filesystem bytes/modes. Stand-ins isolate privileged allocation/activation; they do not choose the script's skip, persistence, permission or idempotence decisions.
5. Refactor resistance: compatible log wording and extra health queries no longer fail the test. Required OS-side effects, native input bytes and privacy mode remain observable.
6. Unique protection: the size helper cannot detect wrong shell execution or missing chmod/fstab/idempotence, while lifecycle uses a generic connection double and does not activate real swap. This is the lowest safe boundary that verifies the generated script without altering the host's swap state.

**`no root access or too little disk: the swap script skips, saying why, and succeeds` — REWRITE**

Final name: `no root access or too little disk skips swap successfully without changing files`.

1. Independent contract: best-effort setup must skip successfully when privilege is unavailable or the disk lacks the specified three-times-size reserve, without creating swap or an fstab entry.
2. Real failure: touching host disk configuration without privilege, allocating an eight-GiB swap file with only twenty GiB free despite the required twenty-four-GiB reserve, or failing the setup on these supported skip conditions.
3. Independent oracle: literal UID 1000 with no sudo in the sandbox, or UID 0 with twenty GiB available; both must exit zero and leave both `swapfile` and `fstab` absent with exact `ENOENT`. The old broad rejection accepted any filesystem error. Twenty GiB also distinguishes the specified three-times reserve from an accidental two-times guard; the former ten-GiB fixture could not.
4. Stable seam: actual generated POSIX script, native privilege/free-space responses, exit status and actual files. No actual host root check or allocation is performed.
5. Refactor resistance: removes English skip-reason copy assertions and requires state and error codes. A behavior-preserving rewrite of the shell can retain these outcomes.
6. Unique protection: successful root setup cannot detect unsafe skip behavior; the numeric memory-size helper never observes disk reserve or permission. Different skip inputs share one inexpensive script harness without repeated end-to-end box provisioning.

**`a box's swap is its memory, from 1 to 8 GiB` — KEEP**

1. Independent contract: the explicitly documented provisioning policy chooses the box's memory rounded to GiB, with a one-GiB minimum and eight-GiB maximum; the historical eight-GB box reports a fractional GiB amount.
2. Real failure: zero swap for a small box, incorrect fractional-memory sizing, unbounded allocation on a large box or wrong ordinary four-GiB sizing.
3. Independent oracle: literal 512-MiB, 7.56-GiB, four-GiB and sixty-four-GiB inputs must return literal `1`, `8`, `4`, `8`; no expected result is calculated through production code.
4. Stable seam: `boxSwapGiB` configuration policy consumed by the real lifecycle setup, with independent byte units.
5. Refactor resistance: no private expression, branch count, source layout or dependency-call shape is inspected; different sizing implementations must produce the same provisioned resources.
6. Unique protection: the shell case explicitly requests eight GiB and cannot detect a bad memory-to-size decision in lifecycle. Provider metadata and generic toolchain planning do not exercise this policy. The production export has a real lifecycle caller and is retained.

### `apps/daemon/src/agent-host/boxes/remote-child.test.ts`

**`a detached child asks the box to keep a large output buffer unless told otherwise` — CONSOLIDATE (removed standalone)**

The old oracle compared captured options against the same imported production constant and an independently unsourced sixty-four-MiB minimum, then started two extra real children to inspect request arguments. The historical deployment requirement is a **128-MiB** reservation. Its default-size assertion now uses that literal on the public `BoxConnection.exec` boundary inside the existing reconnect owner below. The explicit 1024-byte override is already owned more strongly by `agent.integration.test.ts`'s real Go output-overrun test: writing 4096 bytes while disconnected must end and kill that process. A default overriding that explicit size makes the real overrun scenario fail. No unique contract is lost, and both redundant Node child starts disappear.

**`a child the box lists as ended without an exit code or signal never ends as a clean exit` — REWRITE**

1. Independent contract: an unknown process end must be exposed as `ProviderChild` signal termination `SIGHUP`, never fabricated exit zero, and provide an Orquester diagnostic line.
2. Real failure: the previous `code ?? 0` fallback incorrectly reports success and hides the reason the chat stopped, or silently drops the unknown-end diagnostic.
3. Independent oracle: the scripted public box process reports raw `{code:null, signal:null}`; the caller must receive literal `{kind:"signal", code:null, signal:"SIGHUP"}` and a nonempty `[orquester]` stderr annotation. Removed the exact copied English diagnostic sentence.
4. Stable seam: actual child restart/replay harness feeds the public BoxProcess protocol; assertions observe `ProviderChild.exited` and stderr.
5. Refactor resistance: changing internal functions or diagnostic wording preserves the result and tagged annotation. The double supplies raw protocol values; it does not compute the expected `SIGHUP` mapping.
6. Unique protection: the real Go restart uses its `lost` record/reason path, while this case specifically feeds an ended process with both status fields absent. Recorded SIGTERM and missing-record tests have different inputs and cannot detect the fabricated-clean-exit fallback for this wire state.

### `apps/daemon/src/boxes/hub/agent.integration.test.ts`

**`an agent child whose orq-agent was stopped (an OOM-failed unit) ends as lost, never as a clean exit` — REWRITE**

1. Independent contract: when the remote agent dies and its CLI's stdin disappears, a later agent must report that CLI as lost rather than a successful chat completion. The durable Go process record, native relay and public child termination contract jointly own that workflow.
2. Real failure: Go restart recovery forgets the prior child, relay reattachment treats its disappearance as exit zero, or the caller gets no lost-process diagnostic.
3. Independent oracle: actual Go executable, real relay, real shell blocked on stdin, real SIGTERM to orq-agent, restart and public termination. The result must be signal-kind with no exit code and either `SIGHUP` (already ended unseen) or `SIGTERM` (recovery found it still finishing and stopped it), plus a nonempty Orquester diagnostic. These are the two independently documented native recovery outcomes; `procstate.go` confirms the distinction. Exact wording is removed.
4. Stable seam: native process death, durable filesystem process record, wire/relay reconnect and `ProviderChild.exited`/stderr; no injected production restart hook or fake result.
5. Refactor resistance: does not pin English messages or assume which side of an OS scheduling race wins. The separate unknown-status unit still requires exact `SIGHUP` when its input is explicitly known.
6. Unique protection: a fake restart double cannot detect lost Go persistence or cross-language relay handling; the ordinary dropped-link scenario leaves the agent alive, and output-overrun concerns a different protocol fault. It reuses the suite's existing build/server rather than adding infrastructure startups. The expensive agent restart is retained. This test simulates the service stop caused by the incident; it does not exhaust host memory or claim actual kernel OOM coverage.

## Surviving consolidation owner

**`apps/daemon/src/agent-host/boxes/remote-child.test.ts` — `a detached child survives a dropped link and reattaches from the bytes it had` — CONSOLIDATE (surviving owner)**

1. Independent contract: detached children reserve the historical 128-MiB output budget and preserve byte-complete delivery, buffered stdin and process exit across a link drop.
2. Real failure: the daemon falls back to a four-MiB reservation, requests reattach from the wrong offset, loses or duplicates output, fails to deliver held input, or misreports final exit status.
3. Independent oracle: captures only the public outbound `detach.bufferBytes`, requires literal `128 * 1024 * 1024`, then retains exact independent output `ready/echo:a/during-drop/echo:b`, byte offset and exit-seven results. The constant is not imported from production. A failure-path `killAll` hook prevents the added early assertion from leaving a real child alive.
4. Stable seam: public `BoxConnection.exec`/attach offset and ProviderChild streams/results, with real Node stdin/stdout and a link transport double.
5. Refactor resistance: compatible extra exec options or a different internal buffering implementation do not fail; only the documented wire resource reservation and observable reconnect outcomes matter. The capture is not an export or object-member inventory.
6. Unique protection: retains the original reconnect owner and absorbs only the missing default budget contract. The real Go override/overrun case owns caller-specified buffer behavior separately. Starting extra children solely to inspect the same default/override request adds no unique protection.

## Executed validation and native-watch regression control

Root ran these integrated gates successfully:

```sh
pnpm check:changed --no-cache --base 0e61cd5dfed987e9bcbafe097e2582f90586ef4f
pnpm check
TSX_DISABLE_CACHE=1 pnpm build
```

The changed-file gate passed typechecking and **16 daemon test files / 3 UI test files**; the OOM daemon targets are `src/agent-host/boxes/remote-child.test.ts`, `src/boxes/service/toolchain.test.ts` and `src/boxes/hub/agent.integration.test.ts`. Its reported test-stage durations were 36.6 seconds for daemon and 14.9 seconds for UI; these are gate measurements, not a before/after performance comparison. Full workspace typecheck and build passed separately. The combined gate script also contains other smoke checks; the statuses here refer specifically to the commands and controls listed in this report.

Root executed the native-watch validator with a **10,000-ms audit guard**:

```sh
python3 /tmp/orquester-test-audit/validate-native-watch.py --guard-ms 10000
```

| Validator stage | Result | Process wall time |
|---|---|---:|
| Original three-file positive gate | Exit 0; 33 tests passed, no failures/skips | 3.421 s |
| Isolated guarded native-watch case | Exit 0; one test passed | 2.108 s |
| Suppressed native notification dispatch | Expected exit 1; intended missing-notification `ERR_ASSERTION` | 11.682 s |

Evidence: `/tmp/orquester-test-audit/native-watch-controls/summary.json` and its three referenced TAP logs. The negative log contains `failureType: 'testCodeFailure'`, `code: 'ERR_ASSERTION'`, and `NATIVE_WATCH_CALLBACK_REQUIRED: atomic credential replacement produced no native notification`, with one failure and **zero cancellations**. This was an assertion-based regression detection, not a runner timeout or pending-event-loop cancellation. The summary reports `status: passed`, `guard_ms: 10000`, and identical before/after SHA-256 hashes for all four protected source files.

The runner first required the original broker/rules files to pass. It then built a temporary overlay with copies of only `credentials.ts` and `refresh-scheduling.test.ts`; other dependencies were symlinked without modification. Only the isolated audit fixture replaced `await nativeChange` with a ten-second guard and explicit assertion marker. That same guarded copy passed with genuine native dispatch before the runner suppressed the native callback in its isolated port copy. The overlay was removed. Neither source file in the shared checkout was mutated. The ten-second guard is audit instrumentation only; it adds no wait or timeout to the retained test suite, and the positive control clears it when the real notification arrives.

**Remaining validation:** root's final `pnpm test` is running; the final Go race gate is pending. The native Go policy test remains retained, and no final Go-race or full-suite success is claimed here. No additional tests or source edits were performed for this documentation update.
