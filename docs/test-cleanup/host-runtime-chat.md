# Host runtime and daemon chat test cleanup

## Pre-edit disposition record

This inventory was recorded before changing any test or production owner. Scope: all 25 original test files in agent-chat, agent-host top-level, support and server; 339 individually read test cases. No source-grep/check files occur in this scope. Production owners, non-test callers and referenced local contracts were read. Disposition is at original test-title granularity; parameter combinations remain in their named case.

Contract references: `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md`, `docs/superpowers/specs/2026-09-24-agent-goals-design.md`, `docs/superpowers/specs/2026-09-23-thread-index-and-lazy-boot-design.md`, `apps/daemon/src/agent-host/README.md`, root `AGENTS.md`, shared `packages/api/src/agent-chat` contracts and the existing provider fixture provenance.

For each KEEP/REWRITE, the six numbered points in its file record apply to each separately listed required behavior below. The named condition is the independent expected behavior: its violation causes the caller-visible failure described in point 2. DELETE rows identify the failing bar and surviving owner. Fault models are listed before deciding isolated-unit retention.

Validation command prefix (run from `apps/daemon`): `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test --test-concurrency=1`. Append the per-file `src/...test.ts` path. Two handover cases were additionally recorded as REWRITE during final owner review before changing those cases: their direct marker setup bypassed the real stop route. Root owns final `pnpm check`, `pnpm test`, repository diff review and commit/push.

## `apps/daemon/src/agent-chat/activity-ladder.test.ts`

- Fault model before retaining isolated cases: resolveChatActivity/pushTypeForFields: precedence inversion, premature finished, suppressed attention, wrong goal continuation state.
- Non-test callers: summary.ts; MCP wait/views; workflow activity consumers.
- Bar 1 — independent source: GUI design §6.4 and goals design §4.7/§5.5; each row below selects its exact behavior.
- Bar 2 — recognizable failure: precedence inversion, premature finished, suppressed attention, wrong goal continuation state; each named scenario distinguishes the failure it can expose.
- Bar 3 — independent oracle: literal protocol states/codes/bytes, prewritten fixture records, independently controlled external replies, or actual filesystem/process results; expected values are not computed with the production algorithm.
- Bar 4 — stable seam: resolveChatActivity/pushTypeForFields; no retained assertion requires a private call graph.
- Bar 5 — refactor resilience: equivalent output/state/side effects satisfy these assertions even if internal helpers, storage implementation or control flow are renamed/reorganized. REWRITE rows remove the identified exception.
- Bar 6 — unique lowest ownership / remaining stronger coverage: The returned rung is also the public MCP SessionReason and workflow wait discriminator, so its literals are caller-visible protocol data. This is the lowest shared policy seam used outside the daemon poller; duplicated poller ladders are deleted. Distinct rung overlaps and race fallbacks must survive individually.
- Risk: retained cases include migration, security, protocol or credible race/OS regressions; deletions remove duplicate or non-observing assertions. Configuration changes are limited to removing test-only exposure, with behavior preserved.
- Validation: command prefix above plus `src/agent-chat/activity-ladder.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| KEEP | rung 1: a pending approval outranks everything | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | rung 2: a pending question outranks the session state | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | rung 3: a failed session outranks lingering background liveness | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | rung 3: a failed TURN is an error even with a ready session | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | rung 4: starting is working | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | rung 5: a running session or a running turn is working | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | rung 6: an actionable plan on a settled turn is waiting + needs-input | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | rung 6 outranks background working and monitoring | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | rung 6 sits BELOW approval, question, error and a running turn | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | rung 6 needs a SETTLED turn: no turn, or one still open, is not plan-ready | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | rung 7: background liveness `working` keeps the thread working after the turn | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | rung 8: monitoring is idle WITHOUT a finished stamp | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | rung 9: a completed turn is idle + finished | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | race fallback 1: `interrupted` WITH a completedAt is finished | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | race fallback 1 does NOT fire without a completedAt | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | race fallback 2: a live `ready` session with nothing pending is finished | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | an empty summary resolves to nothing rather than to finished | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | attention pushes follow the protocol state and remain silent while work is active | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a plan-ready thread pushes even while background work is live | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a continuing goal keeps a settled turn from reading as finished | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a continuing goal also covers both race fallbacks | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a failed TURN alone does not end a continuing goal — the goal's own status does | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | an errored session is an error unless the HOST says the goal still continues | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a continuing goal never outranks the user or a running turn | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a continuing goal outranks a plan prompt and lingering liveness: the thread is working | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a goal that is not continuing changes nothing | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | never a `finished` push while background liveness is non-null | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |

## `apps/daemon/src/agent-chat/chat-sessions.test.ts`

- Fault model before retaining isolated cases: ChatSessionManager records/summaries and SessionRouter public operations: lost tabs, lost deletion queue, regressed cursors, wrong kind routing or account state.
- Non-test callers: AgentChatService; SessionRouter; SessionManager index contributor; root session API.
- Bar 1 — independent source: GUI design §5.2/§6.1/§6.4 and goals design §4.7; persisted SessionRecord/public session routing contract; each row below selects its exact behavior.
- Bar 2 — recognizable failure: lost tabs, lost deletion queue, regressed cursors, wrong kind routing or account state; each named scenario distinguishes the failure it can expose.
- Bar 3 — independent oracle: literal protocol states/codes/bytes, prewritten fixture records, independently controlled external replies, or actual filesystem/process results; expected values are not computed with the production algorithm.
- Bar 4 — stable seam: ChatSessionManager records/summaries and SessionRouter public operations; no retained assertion requires a private call graph.
- Bar 5 — refactor resilience: equivalent output/state/side effects satisfy these assertions even if internal helpers, storage implementation or control flow are renamed/reorganized. REWRITE rows remove the identified exception.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Persistence and mixed-kind routing are separate owner boundaries; service tests cover transaction ordering, not malformed index rows or mixed list behavior.
- Risk: retained cases include migration, security, protocol or credible race/OS regressions; deletions remove duplicate or non-observing assertions. Configuration changes are limited to removing test-only exposure, with behavior preserved.
- Validation: command prefix above plus `src/agent-chat/chat-sessions.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| KEEP | a created chat tab round-trips through its sessions.json record | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | one bad chat record never poisons the index | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a chat record without a chat block is skipped, not resurrected as a half-thread | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | closing a tab queues a DURABLE host-side delete | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a malformed queued id is dropped, never the whole queue | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | lastSeq is monotonic — a stale frame cannot rewind a tab's cursor | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | the derived §6.4 fields publish only when one actually moved | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | the goal rides the tab and republishes only when it moves (goals §4.7) | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | the tab strip is one list over both kinds, sorted by the shared order | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | reorder spans both kinds: a chat tab dragged between terminals lands there | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | closing a chat tab cascades the host thread delete BEFORE forgetting it | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | renaming a chat tab appends the host's thread.meta-updated | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a managed-hook agent-event for a CHAT session is accepted and ignored, never 404 | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | the PTY-only surface is inert for a chat tab | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | setAccount moves the summary AND the persisted chat block together | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | switching to the system identity drops the summary's account id | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | setAccount is a no-op for an unchanged identity and for an unknown tab | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |

## `apps/daemon/src/agent-chat/home-prep.test.ts`

- Fault model before retaining isolated cases: real .claude.json writer: absent/malformed file, erased user data, broad credential permissions, severed symlink or launch-aborting I/O error.
- Non-test callers: AgentChatService.create and switchAccount via markClaudeProjectTrusted.
- Bar 1 — independent source: GUI design Claude trust amendment and host security rule preserving credential-bearing config; documented account-home symlinks; each row below selects its exact behavior.
- Bar 2 — recognizable failure: absent/malformed file, erased user data, broad credential permissions, severed symlink or launch-aborting I/O error; each named scenario distinguishes the failure it can expose.
- Bar 3 — independent oracle: literal protocol states/codes/bytes, prewritten fixture records, independently controlled external replies, or actual filesystem/process results; expected values are not computed with the production algorithm.
- Bar 4 — stable seam: real .claude.json writer; no retained assertion requires a private call graph.
- Bar 5 — refactor resilience: equivalent output/state/side effects satisfy these assertions even if internal helpers, storage implementation or control flow are renamed/reorganized. REWRITE rows remove the identified exception.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Actual filesystem writer is the lowest stable config seam; pure-transform probes are deleted/consolidated. Service keeps sandbox selection, not duplicate writer mechanics.
- Risk: retained cases include migration, security, protocol or credible race/OS regressions; deletions remove duplicate or non-observing assertions. Configuration changes are limited to removing test-only exposure, with behavior preserved.
- Validation: command prefix above plus `src/agent-chat/home-prep.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| DELETE | a never-seen directory is marked trusted, with onboarding forced | Private transformation probe; the retained absent-file writer case gains these literal persisted flags, proving trust bytes at the production seam. |
| DELETE | an existing project's other settings are preserved | Private transformation probe; preservation moves into the existing real 0644-config writer regression, which also protects credential permissions. |
| REWRITE | a malformed projects map is replaced rather than crashing the launch | Exercise markClaudeProjectTrusted against a real malformed config, then inspect persisted trust flags; stop exporting the private pure transform. |
| DELETE | the other projects in the file survive the grant | Private transformation probe; preservation moves into the existing real 0644-config writer regression, checking actual persisted neighboring project/history data. |
| REWRITE | markClaudeProjectTrusted writes 0600 and survives an absent file | Consolidate first-use onboarding/trust flags at this real persisted-file seam while retaining mode and idempotence checks. |
| REWRITE | a pre-existing 0644 config is NARROWED to 0600, never left wide | Consolidate same-project settings, other projects, history and credential preservation at the real config writer, together with 0600 narrowing. |
| KEEP | a symlinked config is written THROUGH, never replaced by a regular file | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | an unwritable config never fails a launch | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |

## `apps/daemon/src/agent-chat/host-client.test.ts`

- Fault model before retaining isolated cases: HTTP body stream and public error/cause classifier: uncaught body errors, lost cap refusal, false 413 for unrelated errors.
- Non-test callers: AgentChatService upload proxy; upload-stream consumers.
- Bar 1 — independent source: public AgentHostClient/upload error contract; credible body-error regression with early host refusal; each row below selects its exact behavior.
- Bar 2 — recognizable failure: uncaught body errors, lost cap refusal, false 413 for unrelated errors; each named scenario distinguishes the failure it can expose.
- Bar 3 — independent oracle: literal protocol states/codes/bytes, prewritten fixture records, independently controlled external replies, or actual filesystem/process results; expected values are not computed with the production algorithm.
- Bar 4 — stable seam: HTTP body stream and public error/cause classifier; no retained assertion requires a private call graph.
- Bar 5 — refactor resilience: equivalent output/state/side effects satisfy these assertions even if internal helpers, storage implementation or control flow are renamed/reorganized. REWRITE rows remove the identified exception.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Client owns stream rejection/cause preservation; service routes separately own response status and downstream connection cleanup. Neither alone substitutes for the other.
- Risk: retained cases include migration, security, protocol or credible race/OS regressions; deletions remove duplicate or non-observing assertions. Configuration changes are limited to removing test-only exposure, with behavior preserved.
- Validation: command prefix above plus `src/agent-chat/host-client.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| KEEP | a body that fails before the host answers rejects as HOST_UNAVAILABLE, carrying the body's own error as its cause | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | isUploadTooLarge reads the cap refusal bare or as a wrapper's cause, and nothing else | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |

## `apps/daemon/src/agent-chat/owner.test.ts`

- Fault model before retaining isolated cases: parseSessionOwner and public sessions route: accepting malformed ownership, dropping legitimate owner, permitting ownership on terminal sessions.
- Non-test callers: root POST /api/sessions route; AgentChatService.create.
- Bar 1 — independent source: workflow-owned SessionOwner API schema and GUI create-session transport contract; each row below selects its exact behavior.
- Bar 2 — recognizable failure: accepting malformed ownership, dropping legitimate owner, permitting ownership on terminal sessions; each named scenario distinguishes the failure it can expose.
- Bar 3 — independent oracle: literal protocol states/codes/bytes, prewritten fixture records, independently controlled external replies, or actual filesystem/process results; expected values are not computed with the production algorithm.
- Bar 4 — stable seam: parseSessionOwner and public sessions route; no retained assertion requires a private call graph.
- Bar 5 — refactor resilience: equivalent output/state/side effects satisfy these assertions even if internal helpers, storage implementation or control flow are renamed/reorganized. REWRITE rows remove the identified exception.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Parser owns complete field validation; route cases own API status/kind gating and transport propagation. Service persistence is a separate boundary.
- Risk: retained cases include migration, security, protocol or credible race/OS regressions; deletions remove duplicate or non-observing assertions. Configuration changes are limited to removing test-only exposure, with behavior preserved.
- Validation: command prefix above plus `src/agent-chat/owner.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| KEEP | parseSessionOwner accepts the four fields, strips anything else, refuses the rest | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | POST /api/sessions hands a valid owner to the chat create and returns it on the summary | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | POST /api/sessions refuses a malformed owner with 400 INVALID_OWNER before anything is created | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | POST /api/sessions refuses an owner on a terminal tab | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |

## `apps/daemon/src/agent-chat/provider-auth-overlay.test.ts`

- Fault model before retaining isolated cases: overlayManagedAccountAuth: false sign-in toast, wrong account family/default, overwritten system identity, erased non-auth install error.
- Non-test callers: AgentChatService provider snapshots.
- Bar 1 — independent source: GUI design §7.7 managed-account authentication overlay; each row below selects its exact behavior.
- Bar 2 — recognizable failure: false sign-in toast, wrong account family/default, overwritten system identity, erased non-auth install error; each named scenario distinguishes the failure it can expose.
- Bar 3 — independent oracle: literal protocol states/codes/bytes, prewritten fixture records, independently controlled external replies, or actual filesystem/process results; expected values are not computed with the production algorithm.
- Bar 4 — stable seam: overlayManagedAccountAuth; no retained assertion requires a private call graph.
- Bar 5 — refactor resilience: equivalent output/state/side effects satisfy these assertions even if internal helpers, storage implementation or control flow are renamed/reorganized. REWRITE rows remove the identified exception.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Lowest pure reconciliation owner. Fixture snapshots are inputs; fixed expected status/account fields are independent of production filtering.
- Risk: retained cases include migration, security, protocol or credible race/OS regressions; deletions remove duplicate or non-observing assertions. Configuration changes are limited to removing test-only exposure, with behavior preserved.
- Validation: command prefix above plus `src/agent-chat/provider-auth-overlay.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| KEEP | a stale system login is covered by one valid managed account | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | stays unauthenticated when every managed account needs re-auth | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | only the provider's own family counts | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | opencode has no account family and is left alone | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | an authenticated probe is returned as-is | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | an error that was only the missing login becomes ready, message dropped | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a non-auth error keeps its status and text | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | prefers the family default account for the label | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |

## `apps/daemon/src/agent-chat/proxy-routes.test.ts`

- Fault model before retaining isolated cases: public HTTP requests with controlled upstream: lost body/path/query/auth, incorrect status/envelope, leaked raw upstream response, failed stream cancellation.
- Non-test callers: AgentChatService HTTP registration; UI/API/MCP clients through daemon transport.
- Bar 1 — independent source: shared agent-chat API paths/types and GUI design §6.2/§6.3; thread-index prompt/history wire contracts; each row below selects its exact behavior.
- Bar 2 — recognizable failure: lost body/path/query/auth, incorrect status/envelope, leaked raw upstream response, failed stream cancellation; each named scenario distinguishes the failure it can expose.
- Bar 3 — independent oracle: literal protocol states/codes/bytes, prewritten fixture records, independently controlled external replies, or actual filesystem/process results; expected values are not computed with the production algorithm.
- Bar 4 — stable seam: public HTTP requests with controlled upstream; no retained assertion requires a private call graph.
- Bar 5 — refactor resilience: equivalent output/state/side effects satisfy these assertions even if internal helpers, storage implementation or control flow are renamed/reorganized. REWRITE rows remove the identified exception.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Proxy forwarding is the actual contract, so sentinel upstream data is an independent oracle, not a mock implementing proxy behavior. Host tests own host meaning; these own distinct daemon transport transformations.
- Risk: retained cases include migration, security, protocol or credible race/OS regressions; deletions remove duplicate or non-observing assertions. Configuration changes are limited to removing test-only exposure, with behavior preserved.
- Validation: command prefix above plus `src/agent-chat/proxy-routes.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| KEEP | documented commands preserve their path, body, authentication and acknowledgement | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | the host's error envelope is passed through verbatim, status included | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | an unknown session is 404 THREAD_NOT_FOUND and never reaches the host | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a down host is 503 HOST_UNAVAILABLE on commands, reads and the stream | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | an unreachable host socket is 503, not a 500 | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a non-JSON body from the host is a 502, never leaked raw | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a tool call's streamed output is proxied verbatim — the host's own 404 and an older host's route miss alike | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a window of a tool call's streamed output forwards offset/maxBytes verbatim, and passes the window through | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a malformed turn count is rejected before the hop | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a thread read records the sequence it served (§5.2 lastSeq) | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | an events-shaped read records its sequence too | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a refresh broadcasts agent.providers.changed ONLY when it changed something | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | attachment reads reject missing IDs, unknown tabs and unavailable hosts | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | the host-stop route drives the supervisor's drain restart | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | the stream is piped through, and the client disconnect cancels the upstream | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a stream refusal answers the host's envelope rather than an empty stream | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | the account route is daemon-owned: it never hits the host socket itself | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | the account route is 404 for an unknown tab and 503 while the host is down | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a daemon-side refusal answers the §6.2 status of its code, INDEX_UNAVAILABLE included | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a history read forwards before/turns verbatim and passes the page through | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a history read with no query asks the host for the page below the window | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a history read for an unknown tab is 404 THREAD_NOT_FOUND and never reaches the host | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a search forwards q/limit/projectPath verbatim, and only those | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | the host's INDEX_UNAVAILABLE 503 passes through verbatim on history and search | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a host that predates the index (404 on /search) answers the unavailable search shape | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a prompts read forwards before/limit verbatim, and only those, and passes the page through | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a prompt's text is proxied with its id kept one encoded segment | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | prompt reads for an unknown tab are 404 THREAD_NOT_FOUND and never reach the host | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | every prompt-read 404 passes through untouched — the host's own and an older host's route miss | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | the host's `indexed:false` page and its INDEX_UNAVAILABLE 503 pass through verbatim | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |

## `apps/daemon/src/agent-chat/service.test.ts`

- Fault model before retaining isolated cases: public create/switch/provider/upload service and HTTP routes: wrong identity/env, security trust escape, orphan tab, wrong host ordering, upload crash/truncation or connection leak.
- Non-test callers: daemon service lifecycle; session routes; account switches; DaemonApi/MCP.
- Bar 1 — independent source: GUI design §5.2/§6.1/§6.2, trust amendment, goals design §5.7 and agent profile §4.8; binary-upload API; each row below selects its exact behavior.
- Bar 2 — recognizable failure: wrong identity/env, security trust escape, orphan tab, wrong host ordering, upload crash/truncation or connection leak; each named scenario distinguishes the failure it can expose.
- Bar 3 — independent oracle: literal protocol states/codes/bytes, prewritten fixture records, independently controlled external replies, or actual filesystem/process results; expected values are not computed with the production algorithm.
- Bar 4 — stable seam: public create/switch/provider/upload service and HTTP routes; no retained assertion requires a private call graph.
- Bar 5 — refactor resilience: equivalent output/state/side effects satisfy these assertions even if internal helpers, storage implementation or control flow are renamed/reorganized. REWRITE rows remove the identified exception.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Service is the lowest owner for tab-host transactions, account-home selection and HTTP/upload coordination. Simple trust duplication is removed; underlying env/config helpers own independent transformation mechanics.
- Risk: retained cases include migration, security, protocol or credible race/OS regressions; deletions remove duplicate or non-observing assertions. Configuration changes are limited to removing test-only exposure, with behavior preserved.
- Validation: command prefix above plus `src/agent-chat/service.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| KEEP | the launch env is the registry entry's env UNDER the resolveExtraEnv contributors | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | an OpenCode thread carries its per-launcher env file and the PROJECT ROOT | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| DELETE | the project is marked trusted for the home the thread will run under | Duplicates the immediately following validated-projectPath-versus-request-cwd test, which uses the same account home and proves the stronger security boundary. |
| KEEP | trust is granted for the validated projectPath, NEVER the request's cwd | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a projectPath outside the sandbox grants NO trust, and the launch still works | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a Grok thread no longer touches any home config file | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | the tab record is written FIRST and rolled back when the host refuses | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | an agent row with no chat adapter cannot open a chat tab | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a resume id the adapter cannot use is refused at creation, never degraded | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | §6.1's fields ride the nested `chat` block the client sends | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a bad resume in the nested block is refused just as the flat one is | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a workflow owner rides create → summary → sessions.json → re-adoption after a restart | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a tab with no owner writes no owner key | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | the service refuses a malformed owner before the tab or the thread exists | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a switch recomputes the launch env, calls the host, THEN moves the tab record | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | switching to System clears the account and never falls back to the family default | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | an account of another family is refused rather than silently degraded to System | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | an OpenCode thread cannot switch accounts | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a host refusal leaves the tab record exactly as it was | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | an older host with no identity route reads as HOST_UNAVAILABLE, not a refusal | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a switch on an unknown tab is THREAD_NOT_FOUND and a blank commandId is invalid | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | an install/update asks the host to re-probe the provider that entry maps to | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a CLI version change asks the host to refresh its provider catalog | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | agent goals §5.7: a blocked deploy drain posts the goal hold, with authentication | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | agent goals §5.7, a host from before the hold: the snapshot read, the session stop and the hand-over reach the host as sent | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | agent profile §4.8: the OpenCode recycle reaches the host, and no answer makes it throw | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a body that fails mid-upload fails the upload, never the daemon | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | an upload refused before it was sent leaves a failing body nothing to crash on | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | the upload route answers a cap refusal the host client wrapped 413 too, and any other host failure 503 | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a host that refuses an upload before reading it is relayed as is, and the connection closes | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | an upload the host takes is relayed without closing the connection | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a host refusal keeps the client connection open once all upload bytes are off the wire | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a host that refuses while the upload is still arriving has the daemon's request to it torn down | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a fully consumed upload preserves the host answer and all body bytes | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | an over-cap chat upload answers 413 UPLOAD_TOO_LARGE through the MCP seam too, and ends its owned stream | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |

## `apps/daemon/src/agent-chat/session-index.test.ts`

- Fault model before retaining isolated cases: real sessions.json reattachment/save: accidental PTY attach/reap, failed legacy migration, lost mixed records or corrupt overlapping writes.
- Non-test callers: SessionManager persistence and ChatSessionManager contributor.
- Bar 1 — independent source: GUI design §5.2 migration/session persistence and AGENTS.md legacy terminal ownership; each row below selects its exact behavior.
- Bar 2 — recognizable failure: accidental PTY attach/reap, failed legacy migration, lost mixed records or corrupt overlapping writes; each named scenario distinguishes the failure it can expose.
- Bar 3 — independent oracle: literal protocol states/codes/bytes, prewritten fixture records, independently controlled external replies, or actual filesystem/process results; expected values are not computed with the production algorithm.
- Bar 4 — stable seam: real sessions.json reattachment/save; no retained assertion requires a private call graph.
- Bar 5 — refactor resilience: equivalent output/state/side effects satisfy these assertions even if internal helpers, storage implementation or control flow are renamed/reorganized. REWRITE rows remove the identified exception.
- Bar 6 — unique lowest ownership / remaining stronger coverage: This is the actual mixed-kind persistence seam, not a duplicate of single chat-record serialization; realistic close operations replace an unnecessary test seam.
- Risk: retained cases include migration, security, protocol or credible race/OS regressions; deletions remove duplicate or non-observing assertions. Configuration changes are limited to removing test-only exposure, with behavior preserved.
- Validation: command prefix above plus `src/agent-chat/session-index.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| KEEP | reattach routes chat records to their contributor and never attaches a PTY to them | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a chat record is never reaped as an orphan tmux session | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | §5.2 migration: a legacy `agent` record with a live pane stays a terminal, flagged | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | §5.2 migration: a legacy `agent` record with NO live pane is forgotten | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a shell record carries no legacy flag | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | one persisted index holds updated chat and terminal records | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| REWRITE | concurrent writes retain the latest complete session index | Replace the test-only ChatSessionManager.clear shortcut with production close operations before the next save; preserve real disk race assertions. |

## `apps/daemon/src/agent-chat/summary.test.ts`

- Fault model before retaining isolated cases: poll host summaries and observe tab/bus/push outputs: false startup push, missed attention restamp, duplicate pending events, erased last known state or wrong drain readiness.
- Non-test callers: daemon SummaryPoller lifecycle, SessionRouter, workflow bus and push publisher, supervisor drain.
- Bar 1 — independent source: GUI design §6.4 coarse activity/pending/turn events; MCP wait cursor semantics; goals §4.7/§5.5; each row below selects its exact behavior.
- Bar 2 — recognizable failure: false startup push, missed attention restamp, duplicate pending events, erased last known state or wrong drain readiness; each named scenario distinguishes the failure it can expose.
- Bar 3 — independent oracle: literal protocol states/codes/bytes, prewritten fixture records, independently controlled external replies, or actual filesystem/process results; expected values are not computed with the production algorithm.
- Bar 4 — stable seam: poll host summaries and observe tab/bus/push outputs; no retained assertion requires a private call graph.
- Bar 5 — refactor resilience: equivalent output/state/side effects satisfy these assertions even if internal helpers, storage implementation or control flow are renamed/reorganized. REWRITE rows remove the identified exception.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Retains poll comparison, field validation and publication semantics; deletes repeated pure ladder scenarios owned by activity-ladder. Same-turn/new-id/replayed-row cases are different credible missed-wakeup failure modes.
- Risk: retained cases include migration, security, protocol or credible race/OS regressions; deletions remove duplicate or non-observing assertions. Configuration changes are limited to removing test-only exposure, with behavior preserved.
- Validation: command prefix above plus `src/agent-chat/summary.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| DELETE | a pending approval pushes 'needs your input' exactly once per raise | Duplicates the stronger restamp-only notification case, which crosses several polls, changes request identity, and checks push count and attention transitions. |
| KEEP | a daemon restart NEVER pushes for state it is merely discovering | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a re-adopted thread (after forget) also seeds silently | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| DELETE | NEVER a 'finished' push while background liveness is non-null | Duplicates activity-ladder's exhaustive push suppression rule, including errored sessions; summary retains real liveness propagation/drain tests and notification transition ownership. |
| DELETE | a continuing goal holds the finished stamp and push until the goal stops (goals §4.7) | Replays the activity-ladder goal precedence contract one layer higher. Goal parsing/propagation, notification transitions and ladder decisions retain separate owners. |
| DELETE | a goal turn killed by a restart raises no finished stamp or push while its resume is owed (goals §5.5) | Repeats activity-ladder's errored-session/continuing-goal case with arranged host summaries; it does not exercise an actual restart. Real restart/continuation is covered by host-teardown and goals owners. |
| KEEP | a continuing goal never feeds the drain's background-work view (goals §4.7) | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | an errored thread keeps status 'running' — the TAB is live — and shows the error via activity | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| DELETE | an errored thread whose watch loop is still live does not push 'finished' | Duplicates activity-ladder's non-null-background push suppression matrix. Summary retains error-to-tab state propagation independently. |
| KEEP | needsAttentionAt is stamped when attention rises and cleared when it clears | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | approval A answered and approval B raised inside one poll restamps, and says so on the bus | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a turn that starts and settles inside one poll restamps; a turn that stays settled does not | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | the same turn settling under a still-open question restamps too | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a request that stays open keeps its stamp; only a request id the last poll lacked restamps | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a restamp alone never pushes: pushes stay gated on the attention VALUE changing | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a rewind back onto a turn that settled long ago keeps the stamp | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a history replay committing settled rows one poll at a time keeps the stamp | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | two turns that fail before the provider names them, inside one poll, restamp | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a turn moving into pending or running never restamps, whatever its completedAt says | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a turn transition becomes the coarse agentChat.turn bus event | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a settled turn reopens the version drain window | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | agentChat.pending fires once per open and once per close, deduped across polls | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | one request closing while another opens is TWO events, not silence | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | approvals and questions keep their kinds (different UI, different push copy) | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a malformed pending row is dropped rather than published | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a thread the host no longer has closes out its open requests | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | agent.providers.changed is the one coarse provider event | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| DELETE | forget() stops a closed tab producing any further activity | Passes for the wrong reason: the tab is closed as well as forgotten, so refreshAll has no tab to poll even if forget does nothing. Re-adoption after forget remains and detects stale memo state. |
| KEEP | a failed read leaves the last known state alone rather than blanking the tab | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a summary body is validated field-wise before it reaches typed code | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | the daemon's own background-liveness view feeds the drain, and its ending reopens the window | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | hasPolled flips after the first completed poll round, even an empty one | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | the goal is validated field-wise, with a fallback, before the ladder reads it | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a thread's live usage reading is handed on once per new reading, with the tab's entry | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |

## `apps/daemon/src/agent-chat/supervisor.test.ts`

- Fault model before retaining isolated cases: supervisor public lifecycle with process/transport fakes: lost active work, foreign-process kill, stale token race, fatal unhandled spawn, endless retry or lost legacy goal handover.
- Non-test callers: AgentChatService start/health/restart; daemon stop protection.
- Bar 1 — independent source: GUI design §3.1/§3.3/§8 host adoption and drain lifecycle; goals §5.7; AGENTS.md session ownership and secrets; each row below selects its exact behavior.
- Bar 2 — recognizable failure: lost active work, foreign-process kill, stale token race, fatal unhandled spawn, endless retry or lost legacy goal handover; each named scenario distinguishes the failure it can expose.
- Bar 3 — independent oracle: literal protocol states/codes/bytes, prewritten fixture records, independently controlled external replies, or actual filesystem/process results; expected values are not computed with the production algorithm.
- Bar 4 — stable seam: supervisor public lifecycle with process/transport fakes; no retained assertion requires a private call graph.
- Bar 5 — refactor resilience: equivalent output/state/side effects satisfy these assertions even if internal helpers, storage implementation or control flow are renamed/reorganized. REWRITE rows remove the identified exception.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Lowest stable host-supervision state-machine owner; tests model external process/probe replies and assert externally meaningful spawn/kill/hold decisions. Real teardown tests own provider flush/continuation, not supervisor decisions.
- Risk: retained cases include migration, security, protocol or credible race/OS regressions; deletions remove duplicate or non-observing assertions. Configuration changes are limited to removing test-only exposure, with behavior preserved.
- Validation: command prefix above plus `src/agent-chat/supervisor.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| KEEP | case 2: healthy + same protocol version adopts without spawning | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | case 3: a version mismatch adopts first, then restarts once drained | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | case 3: a moved CODE stamp is a drain-restart too, not only a protocol bump | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | the same code stamp, or an unknown one on either side, adopts without restarting | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | case 3: a version mismatch with an ACTIVE turn adopts and waits | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | case 4: a token rejection from a process that is not ours is FOREIGN — never killed | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a token rejection from OUR OWN service session is a stale token, not a stranger | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | case 5: nothing answers → spawn and poll READINESS | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a host that never reaches readiness leaves the supervisor stopped, not healthy | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a replacement that becomes ready after its deadline is adopted without another restart | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | health supervision respawns a dead host and latches error after the cap | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a changed hostInstanceId is observable (a restart is not a reconnect) | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | the host pid is in the kill guard's protected set | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | the no-tmux fallback spawns a direct child and protects its pid | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a throwing tmux spawn NEVER rejects out of checkHealth (it would kill the daemon) | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a spawn that throws during boot adoption leaves the supervisor retryable | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a leftover service session is killed before the respawn | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | the drain-restart re-probes: a stale 'no active turn' never kills a live turn | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | one missed probe does NOT kill a healthy-but-busy host | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a busy host gets MORE patience before it is killed | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a single answered probe clears the missed-probe streak | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | the old host is given a grace window to EXIT before its session is killed — a closed socket is not enough | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | the grace window is bounded — a host that never exits is killed anyway | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | case 3: live BACKGROUND work blocks the drain exactly like an active turn | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | an older host that omits the background field is still held by the daemon's own liveness view | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | an older host is held while the daemon's view is still UNKNOWN — boot adoption runs before the first poll | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a host that reports the background field itself is never held by an unknown daemon view | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a host with only background work gets the same extra patience as a busy one | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | agent goals §5.7: every blocked drain evaluation asks the host to hold its continuing goals | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | agent goals §5.7: no hold is asked for without a deploy waiting, or on a drained host | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | agent goals §5.7: a manual restart never asks for a hold, even with a deploy's restart pending | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | agent goals §5.7: a failing hold request never stops the drain, and never prevents a later restart | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | agent goals §5.7: a host that predates the route is not asked again, but another instance is | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | agent goals §5.7: boot adoption never waits for the hold — the daemon listens while the host answers | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | agent goals §5.7: a restart may overtake a hold in flight, and stays healthy after its late answer | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | agent goals §5.7, an older host: a Codex goal loop is stopped at its turn boundary, and the next host resumes its session | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | agent goals §5.7, an older host: two goal loops are each stopped at their OWN boundary | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | agent goals §5.7, an older host: anything else in the way stops nothing, and the deploy waits as before | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | agent goals §5.7, an older host: a stop that fails is tried again and handed over all the same; a hand-over the new host cannot take is asked again | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | agent goals §5.7, an older host: a stop whose reply is lost may still have landed — its thread is handed over | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | legacyGoalTurnOf: a Codex turn with no user message behind it, started as the one before ended, is a goal loop | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | the token is regenerated AFTER the old session is killed, never before | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a moved providersRevision raises agent.providers.changed | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | an older host with no providersRevision never raises the event | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | the launch environment is built explicitly, never from process.env | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |

## `apps/daemon/src/agent-host/main.test.ts`

- Fault model before retaining isolated cases: real isolated host boot and durable files: stale upload work survives a host downtime/restart or fresh work is deleted.
- Non-test callers: agent-host process boot.
- Bar 1 — independent source: GUI design §3.1 startup housekeeping and persisted upload/session retention; each row below selects its exact behavior.
- Bar 2 — recognizable failure: stale upload work survives a host downtime/restart or fresh work is deleted; each named scenario distinguishes the failure it can expose.
- Bar 3 — independent oracle: literal protocol states/codes/bytes, prewritten fixture records, independently controlled external replies, or actual filesystem/process results; expected values are not computed with the production algorithm.
- Bar 4 — stable seam: real isolated host boot and durable files; no retained assertion requires a private call graph.
- Bar 5 — refactor resilience: equivalent output/state/side effects satisfy these assertions even if internal helpers, storage implementation or control flow are renamed/reorganized. REWRITE rows remove the identified exception.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Composition-only startup-wiring regression cannot be proven by the sweeper unit; isolated appdir artifact is inspected.
- Risk: retained cases include migration, security, protocol or credible race/OS regressions; deletions remove duplicate or non-observing assertions. Configuration changes are limited to removing test-only exposure, with behavior preserved.
- Validation: command prefix above plus `src/agent-host/main.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| KEEP | sweeps once at boot, so a restart collects what accumulated while it was down | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |

## `apps/daemon/src/agent-host/host-teardown.test.ts`

- Fault model before retaining isolated cases: isolated host instance, child processes and durable events.ndjson: orphan helpers, missing terminal rows, lost active turns, failed resume or shutdown completion before helper cleanup.
- Non-test callers: real agent-host process main shutdown; daemon supervisor handover.
- Bar 1 — independent source: GUI design §3.3 intentional shutdown and durable append-only logs; provider lifecycle and continuation regressions; each row below selects its exact behavior.
- Bar 2 — recognizable failure: orphan helpers, missing terminal rows, lost active turns, failed resume or shutdown completion before helper cleanup; each named scenario distinguishes the failure it can expose.
- Bar 3 — independent oracle: literal protocol states/codes/bytes, prewritten fixture records, independently controlled external replies, or actual filesystem/process results; expected values are not computed with the production algorithm.
- Bar 4 — stable seam: isolated host instance, child processes and durable events.ndjson; no retained assertion requires a private call graph.
- Bar 5 — refactor resilience: equivalent output/state/side effects satisfy these assertions even if internal helpers, storage implementation or control flow are renamed/reorganized. REWRITE rows remove the identified exception.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Critical composition ownership: actual lifecycle/IPC/log artifacts across stop and new host. Provider unit tests cannot establish lifecycle + durable ordering + restart integration.
- Risk: retained cases include migration, security, protocol or credible race/OS regressions; deletions remove duplicate or non-observing assertions. Configuration changes are limited to removing test-only exposure, with behavior preserved.
- Validation: command prefix above plus `src/agent-host/host-teardown.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| KEEP | a host teardown waits for every Grok session's stop: its helpers swept, the left-running row and the stop in the log, its work left running | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| REWRITE | a helper that ignores SIGTERM is killed inside the SIGTERM path's 3 s backstop | Root-review disposition recorded before this edit: retain actual helper disappearance at completed authenticated HTTP stop, bounded by a watchdog; remove the total-stop wall-clock measurement, which never ran the SIGTERM process-entry backstop and included unrelated log/index/cache draining and scheduling. The lower Grok lifecycle test owns the independently documented 1000 ms TERM→KILL grace using a real helper and controlled time. Composition uniquely catches an early onStopped completion or an orphan after shutdown. |
| KEEP | a host teardown waits for every Codex session's stop: the turn's settle, a live agent's stop and the session's in the log, the child gone | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | the user's end of a Grok session is prepared before its card is answered: a CLI that exits on the cancel still has its work stopped, and its row says so | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| REWRITE | an intentional stop's running Grok turn is continued by the next host, the teardown's rows kept | Final owner review: the handover manually marked continuation, bypassing the HTTP stop composition. Issue authenticated POST /stop with AgentHostClient, assert acknowledged thread ids, await the production onStopped lifecycle callback, then retain the durable log and next-host continuation assertions. The oracle is the real persisted resumed turn, independent of the route implementation; this is the lowest stable composition seam for this regression. |
| REWRITE | an intentional stop's running Codex turn is continued by the next host, the teardown's rows kept | Final owner review: the handover manually marked continuation, bypassing the HTTP stop composition. Issue authenticated POST /stop with AgentHostClient, assert acknowledged thread ids, await the production onStopped lifecycle callback, then retain the durable log and next-host continuation assertions. The oracle is the real persisted resumed turn, independent of the route implementation; this is the lowest stable composition seam for this regression. |

## `apps/daemon/src/agent-host/support/code-stamp.test.ts`

- Fault model before retaining isolated cases: real temporary git-layout files: stale build incorrectly adopted because detached/packed/worktree identity is unreadable.
- Non-test callers: agent-host main and AgentChatService readCodeStamp; supervisor codeStampsDiffer.
- Bar 1 — independent source: Git HEAD/packed-refs/worktree file formats; GUI design code-version drain amendment; each row below selects its exact behavior.
- Bar 2 — recognizable failure: stale build incorrectly adopted because detached/packed/worktree identity is unreadable; each named scenario distinguishes the failure it can expose.
- Bar 3 — independent oracle: literal protocol states/codes/bytes, prewritten fixture records, independently controlled external replies, or actual filesystem/process results; expected values are not computed with the production algorithm.
- Bar 4 — stable seam: real temporary git-layout files; no retained assertion requires a private call graph.
- Bar 5 — refactor resilience: equivalent output/state/side effects satisfy these assertions even if internal helpers, storage implementation or control flow are renamed/reorganized. REWRITE rows remove the identified exception.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Filesystem parser owns git layout variants; boolean comparison duplicate is deleted in favor of supervisor restart/adoption cases.
- Risk: retained cases include migration, security, protocol or credible race/OS regressions; deletions remove duplicate or non-observing assertions. Configuration changes are limited to removing test-only exposure, with behavior preserved.
- Validation: command prefix above plus `src/agent-host/support/code-stamp.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| KEEP | resolves a symbolic HEAD through a loose ref | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | falls back to packed-refs and reads a detached HEAD verbatim | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | follows a worktree's gitdir pointer and its commondir for refs | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | is null outside a repository and never throws | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| DELETE | only two known, different stamps differ | Boolean helper truth table duplicates supervisor adoption/drain cases for changed, equal and unknown stamps; those observe an actual restart decision. The helper retains its production supervisor caller. |

## `apps/daemon/src/agent-host/support/deadline.test.ts`

- Fault model before retaining isolated cases: withDeadline public promise outcome and abort callbacks: wrong winning result, swallowed failure, cancellation hang or unhandled late rejection.
- Non-test callers: provider adapters, orchestrator, host HTTP server.
- Bar 1 — independent source: host startup/provider deadline and cancellation contract, GUI design §3.1; each row below selects its exact behavior.
- Bar 2 — recognizable failure: wrong winning result, swallowed failure, cancellation hang or unhandled late rejection; each named scenario distinguishes the failure it can expose.
- Bar 3 — independent oracle: literal protocol states/codes/bytes, prewritten fixture records, independently controlled external replies, or actual filesystem/process results; expected values are not computed with the production algorithm.
- Bar 4 — stable seam: withDeadline public promise outcome and abort callbacks; no retained assertion requires a private call graph.
- Bar 5 — refactor resilience: equivalent output/state/side effects satisfy these assertions even if internal helpers, storage implementation or control flow are renamed/reorganized. REWRITE rows remove the identified exception.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Lowest reusable deadline seam; caller tests establish their own policy, not all promise race/error modes.
- Risk: retained cases include migration, security, protocol or credible race/OS regressions; deletions remove duplicate or non-observing assertions. Configuration changes are limited to removing test-only exposure, with behavior preserved.
- Validation: command prefix above plus `src/agent-host/support/deadline.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| KEEP | resolves the underlying value when it beats the deadline | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | propagates the underlying rejection unchanged | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | expiry rejects with DeadlineExceededError and runs onTimeout | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a late rejection after expiry does not become an unhandled rejection | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a failing onTimeout never replaces the deadline error | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | an abort signal wins, before and during the wait | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |

## `apps/daemon/src/agent-host/support/env.test.ts`

- Fault model before retaining isolated cases: buildProviderEnv values: ambient vendor credential leak, wrong account home/PATH/TMPDIR, missing process ownership marker or session id.
- Non-test callers: agent-host main launches; provider sessions and AgentChatService account env selection.
- Bar 1 — independent source: GUI design §3.1 child env allowlist and account-home/launch identity; AGENTS.md secret isolation; each row below selects its exact behavior.
- Bar 2 — recognizable failure: ambient vendor credential leak, wrong account home/PATH/TMPDIR, missing process ownership marker or session id; each named scenario distinguishes the failure it can expose.
- Bar 3 — independent oracle: literal protocol states/codes/bytes, prewritten fixture records, independently controlled external replies, or actual filesystem/process results; expected values are not computed with the production algorithm.
- Bar 4 — stable seam: buildProviderEnv values; no retained assertion requires a private call graph.
- Bar 5 — refactor resilience: equivalent output/state/side effects satisfy these assertions even if internal helpers, storage implementation or control flow are renamed/reorganized. REWRITE rows remove the identified exception.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Security allowlist/precedence owner. Spawn integration tests cover actual OS inheritance separately; caller tests do not enumerate toxic ambient/extraEnv values.
- Risk: retained cases include migration, security, protocol or credible race/OS regressions; deletions remove duplicate or non-observing assertions. Configuration changes are limited to removing test-only exposure, with behavior preserved.
- Validation: command prefix above plus `src/agent-host/support/env.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| KEEP | the env is built from nothing — process.env is never spread | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | every adapter binds its account home through its own variable | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | ambient vendor credentials are stripped from extraEnv | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | extraEnv can never move a child off the session PATH, TMPDIR or HOME | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | the account binding wins over anything extraEnv sets | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | undefined values are dropped, never stringified | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | every adapter's launch carries its own launch marker, which no launcher env shadows | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | ORQUESTER_SESSION_ID is always stamped | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |

## `apps/daemon/src/agent-host/support/leftover-processes.test.ts`

- Fault model before retaining isolated cases: process scanner/signal executor against synthetic /proc and real subprocesses: kill stranger/recycled PID, miss orphan member, fail escalation or touch unsupported OS.
- Non-test callers: Grok session cleanup; leftover-work sweeper; workflows sandbox parseStat.
- Bar 1 — independent source: Linux /proc stat/environ identity; host README leftover-work safety; AGENTS.md process/session ownership; each row below selects its exact behavior.
- Bar 2 — recognizable failure: kill stranger/recycled PID, miss orphan member, fail escalation or touch unsupported OS; each named scenario distinguishes the failure it can expose.
- Bar 3 — independent oracle: literal protocol states/codes/bytes, prewritten fixture records, independently controlled external replies, or actual filesystem/process results; expected values are not computed with the production algorithm.
- Bar 4 — stable seam: process scanner/signal executor against synthetic /proc and real subprocesses; no retained assertion requires a private call graph.
- Bar 5 — refactor resilience: equivalent output/state/side effects satisfy these assertions even if internal helpers, storage implementation or control flow are renamed/reorganized. REWRITE rows remove the identified exception.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Synthetic proc fixtures enable exact PID-reuse races unavailable reliably at process integration; real /proc test uniquely proves kernel format/session semantics. Signal recorder asserts permitted targets, not private implementation shape.
- Risk: retained cases include migration, security, protocol or credible race/OS regressions; deletions remove duplicate or non-observing assertions. Configuration changes are limited to removing test-only exposure, with behavior preserved.
- Validation: command prefix above plus `src/agent-host/support/leftover-processes.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| KEEP | finds exactly the processes of a recorded session carrying this launch's marker | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a recycled session id is not ours: its live leader must be the process recorded | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a member whose leader is gone is still its session's | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a pid recycled while it was being read is not matched | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | SIGTERM first; SIGKILL only for what outlived the grace, by a fresh scan of the same sessions | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | the wait ends as soon as everything is gone — a zombie counts as gone | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a pid recycled before its signal is never signalled | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | off Linux there is no /proc: nothing is read and nothing is signalled | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | an empty launch id matches nothing | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | recordChildSessions: each child's own session, and the parent's for a child that shares it | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | the real /proc: a recorded session's members are stopped, a daemon and a stranger spared | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |

## `apps/daemon/src/agent-host/support/leftover-work.test.ts`

- Fault model before retaining isolated cases: actual sidecar persistence plus sweep boundary: lost launch records, broad permissions, malformed data crash, recreated deleted thread or multiplied shutdown delay.
- Non-test callers: Grok background session lifecycle and host close/boot sweeps.
- Bar 1 — independent source: host README retained-work.json format, 0600, 8 launches/64 sessions bounds, no ghost threads; each row below selects its exact behavior.
- Bar 2 — recognizable failure: lost launch records, broad permissions, malformed data crash, recreated deleted thread or multiplied shutdown delay; each named scenario distinguishes the failure it can expose.
- Bar 3 — independent oracle: literal protocol states/codes/bytes, prewritten fixture records, independently controlled external replies, or actual filesystem/process results; expected values are not computed with the production algorithm.
- Bar 4 — stable seam: actual sidecar persistence plus sweep boundary; no retained assertion requires a private call graph.
- Bar 5 — refactor resilience: equivalent output/state/side effects satisfy these assertions even if internal helpers, storage implementation or control flow are renamed/reorganized. REWRITE rows remove the identified exception.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Storage writer/reader owns tolerance/concurrency/bounds; proc tests own identity checks; sweep tests own assembling remembered launches and clearing durable work.
- Risk: retained cases include migration, security, protocol or credible race/OS regressions; deletions remove duplicate or non-observing assertions. Configuration changes are limited to removing test-only exposure, with behavior preserved.
- Validation: command prefix above plus `src/agent-host/support/leftover-work.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| KEEP | a thread's leftover work is kept per launch, merged by launch, the newest launches only, 0600 | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a launch keeps its newest sessions only | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a file that is not what this host writes reads as nothing, entry by entry | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a record never recreates a thread directory that is gone — no ghost thread at the next boot | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | concurrent records of one thread are serialised: none is lost | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | the sweep stops each launch's work by its own marker and sessions — nothing else — then forgets it | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a close sweeps every remembered launch at once: one grace window, not one per launch | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a thread with nothing remembered sweeps nothing, and off Linux nothing is read | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |

## `apps/daemon/src/agent-host/support/ndjson.test.ts`

- Fault model before retaining isolated cases: reader/writer public byte stream: corrupted split codepoint, phantom line, dropped final frame, unbounded queue or post-close write.
- Non-test callers: Codex protocol and Grok transport/ACP connection.
- Bar 1 — independent source: NDJSON/UTF-8/CRLF provider framing and backpressure contract, host README transport map; each row below selects its exact behavior.
- Bar 2 — recognizable failure: corrupted split codepoint, phantom line, dropped final frame, unbounded queue or post-close write; each named scenario distinguishes the failure it can expose.
- Bar 3 — independent oracle: literal protocol states/codes/bytes, prewritten fixture records, independently controlled external replies, or actual filesystem/process results; expected values are not computed with the production algorithm.
- Bar 4 — stable seam: reader/writer public byte stream; no retained assertion requires a private call graph.
- Bar 5 — refactor resilience: equivalent output/state/side effects satisfy these assertions even if internal helpers, storage implementation or control flow are renamed/reorganized. REWRITE rows remove the identified exception.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Lowest framing owner; provider replay fixtures ordinarily use full frames and cannot uniquely detect arbitrary transport splits/pressure.
- Risk: retained cases include migration, security, protocol or credible race/OS regressions; deletions remove duplicate or non-observing assertions. Configuration changes are limited to removing test-only exposure, with behavior preserved.
- Validation: command prefix above plus `src/agent-host/support/ndjson.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| KEEP | line reader carries a remainder across chunk boundaries | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | line reader strips CRLF and never emits a phantom blank line on a split CRLF | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | line reader strips a leading BOM exactly once | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | line reader flushes an unterminated final line | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | line reader decodes a multi-byte codepoint split across chunks | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | parseNdjsonLine skips blanks and comments | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | writer queues behind backpressure and flushes in order on drain | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | writer drops rather than growing past the queue budget | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | writer survives a non-serialisable record without taking the stream down | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | writer appends the newline only when missing, and stops after close | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |

## `apps/daemon/src/agent-host/support/spawn-group.test.ts`

- Fault model before retaining isolated cases: real provider child/grandchild process group: descendant survives provider shutdown.
- Non-test callers: provider child termination via spawnProvider.
- Bar 1 — independent source: host provider lifecycle requires descendant process-group termination; AGENTS.md PTY/process ownership; each row below selects its exact behavior.
- Bar 2 — recognizable failure: descendant survives provider shutdown; each named scenario distinguishes the failure it can expose.
- Bar 3 — independent oracle: literal protocol states/codes/bytes, prewritten fixture records, independently controlled external replies, or actual filesystem/process results; expected values are not computed with the production algorithm.
- Bar 4 — stable seam: real provider child/grandchild process group; no retained assertion requires a private call graph.
- Bar 5 — refactor resilience: equivalent output/state/side effects satisfy these assertions even if internal helpers, storage implementation or control flow are renamed/reorganized. REWRITE rows remove the identified exception.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Distinct kernel process-group ownership seam; single-child spawn test cannot detect an orphan grandchild.
- Risk: retained cases include migration, security, protocol or credible race/OS regressions; deletions remove duplicate or non-observing assertions. Configuration changes are limited to removing test-only exposure, with behavior preserved.
- Validation: command prefix above plus `src/agent-host/support/spawn-group.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| KEEP | a grandchild dies with the provider child | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |

## `apps/daemon/src/agent-host/support/spawn.test.ts`

- Fault model before retaining isolated cases: real child process and public result: inherited secrets, missing stderr/exit status, uncaught ENOENT, stuck process or repeated kill failure.
- Non-test callers: Claude/Codex/Grok provider process launches.
- Bar 1 — independent source: GUI design §3.1 subprocess outcome, explicit env, stderr and escalation rules; each row below selects its exact behavior.
- Bar 2 — recognizable failure: inherited secrets, missing stderr/exit status, uncaught ENOENT, stuck process or repeated kill failure; each named scenario distinguishes the failure it can expose.
- Bar 3 — independent oracle: literal protocol states/codes/bytes, prewritten fixture records, independently controlled external replies, or actual filesystem/process results; expected values are not computed with the production algorithm.
- Bar 4 — stable seam: real child process and public result; no retained assertion requires a private call graph.
- Bar 5 — refactor resilience: equivalent output/state/side effects satisfy these assertions even if internal helpers, storage implementation or control flow are renamed/reorganized. REWRITE rows remove the identified exception.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Lowest OS spawn owner, different from env policy pure builder and descendant group integration. Fixed child script exit/data are an external oracle.
- Risk: retained cases include migration, security, protocol or credible race/OS regressions; deletions remove duplicate or non-observing assertions. Configuration changes are limited to removing test-only exposure, with behavior preserved.
- Validation: command prefix above plus `src/agent-host/support/spawn.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| KEEP | records the pid and resolves with the exit code | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | the environment is exactly what was passed — nothing is inherited | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | stderr is piped, not discarded | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a spawn failure is an outcome, never a throw | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | kill escalates SIGTERM to SIGKILL past the grace deadline | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | kill is idempotent and safe after the child is already gone | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | exitOutcome follows the §3.1 rule | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |

## `apps/daemon/src/agent-host/support/stderr.test.ts`

- Fault model before retaining isolated cases: redacted emitted lines/tail: leaked credential or home path, terminal escapes in UI, lost error severity, corrupted chunking or unbounded diagnostics.
- Non-test callers: all provider adapters; agent-profile CLI runner stripAnsi.
- Bar 1 — independent source: GUI design §3.1 ANSI cleanup/redaction/classification/4KiB tail and provider fixture redaction provenance; each row below selects its exact behavior.
- Bar 2 — recognizable failure: leaked credential or home path, terminal escapes in UI, lost error severity, corrupted chunking or unbounded diagnostics; each named scenario distinguishes the failure it can expose.
- Bar 3 — independent oracle: literal protocol states/codes/bytes, prewritten fixture records, independently controlled external replies, or actual filesystem/process results; expected values are not computed with the production algorithm.
- Bar 4 — stable seam: redacted emitted lines/tail; no retained assertion requires a private call graph.
- Bar 5 — refactor resilience: equivalent output/state/side effects satisfy these assertions even if internal helpers, storage implementation or control flow are renamed/reorganized. REWRITE rows remove the identified exception.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Lowest privacy/framing owner with literal hazardous fixtures. Repeated cache-internal probe is removed; each remaining case protects a distinct token/path/frame boundary.
- Risk: retained cases include migration, security, protocol or credible race/OS regressions; deletions remove duplicate or non-observing assertions. Configuration changes are limited to removing test-only exposure, with behavior preserved.
- Validation: command prefix above plus `src/agent-host/support/stderr.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| KEEP | stripAnsi removes colour, cursor and OSC sequences | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | redaction collapses home paths, longest first | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| REWRITE | redaction collapses a percent-encoded home too, in either hex case | Remove repeated compiled-regex cache probe with an expected string generated by replace; retain literal encoded-home, case and regex-metacharacter privacy oracles. |
| KEEP | redaction masks auth headers, bearer values and token shapes | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | classification: benign snippets and sub-ERROR levels drop | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | classification: fatal snippets become errors, everything else a warning | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | classification redacts before it classifies, so the text is always safe | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | capture splits lines with a remainder and flushes the tail | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | capture keeps a redacted, bounded tail | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | capture tolerates a single line longer than the whole tail budget | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |

## `apps/daemon/src/agent-host/support/tail-file.test.ts`

- Fault model before retaining isolated cases: real output files: duplicate/missing appended bytes, split Unicode corruption, uncapped output, repeated unreadable notices or missed truncation restart.
- Non-test callers: Claude background task output capture.
- Bar 1 — independent source: Claude background-output cap/UTF-8 offset contract; provider fixture and host module map; each row below selects its exact behavior.
- Bar 2 — recognizable failure: duplicate/missing appended bytes, split Unicode corruption, uncapped output, repeated unreadable notices or missed truncation restart; each named scenario distinguishes the failure it can expose.
- Bar 3 — independent oracle: literal protocol states/codes/bytes, prewritten fixture records, independently controlled external replies, or actual filesystem/process results; expected values are not computed with the production algorithm.
- Bar 4 — stable seam: real output files; no retained assertion requires a private call graph.
- Bar 5 — refactor resilience: equivalent output/state/side effects satisfy these assertions even if internal helpers, storage implementation or control flow are renamed/reorganized. REWRITE rows remove the identified exception.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Lowest filesystem output-tail owner; adapter tests consume summaries and do not create append/truncate/read-error edge cases.
- Risk: retained cases include migration, security, protocol or credible race/OS regressions; deletions remove duplicate or non-observing assertions. Configuration changes are limited to removing test-only exposure, with behavior preserved.
- Validation: command prefix above plus `src/agent-host/support/tail-file.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| KEEP | reads only the bytes appended since the previous read | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | a multibyte character split across two reads decodes once, whole | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | stops at the per-shell cap with one truncation notice naming the file | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | an unreadable file yields ONE notice carrying the code and the path, then nothing | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | restarts from the beginning when the file is truncated under it | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | resolves a leading ~/ against the CLI's own HOME and leaves everything else alone | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |

## `apps/daemon/src/agent-host/server/http-server.test.ts`

- Fault model before retaining isolated cases: real Unix-socket HTTP/NDJSON: unauthorized access, wrong route/status/bytes/pagination, lost live events, unclosed connection or invalid goal hold/resume response.
- Non-test callers: daemon AgentHostClient, summary poller and supervisor; public host Unix socket clients.
- Bar 1 — independent source: GUI design §6.2/§6.3/§6.6, host-protocol.ts, shared wire types, thread-index and goals protocols; each row below selects its exact behavior.
- Bar 2 — recognizable failure: unauthorized access, wrong route/status/bytes/pagination, lost live events, unclosed connection or invalid goal hold/resume response; each named scenario distinguishes the failure it can expose.
- Bar 3 — independent oracle: literal protocol states/codes/bytes, prewritten fixture records, independently controlled external replies, or actual filesystem/process results; expected values are not computed with the production algorithm.
- Bar 4 — stable seam: real Unix-socket HTTP/NDJSON; no retained assertion requires a private call graph.
- Bar 5 — refactor resilience: equivalent output/state/side effects satisfy these assertions even if internal helpers, storage implementation or control flow are renamed/reorganized. REWRITE rows remove the identified exception.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Public protocol exception: server owns parsing/serialization/status and transport lifecycle; orchestrator/index units own domain transitions. Bogus pre-arranged stop ordering is deleted; open-stream count becomes observed client close.
- Risk: retained cases include migration, security, protocol or credible race/OS regressions; deletions remove duplicate or non-observing assertions. Configuration changes are limited to removing test-only exposure, with behavior preserved.
- Validation: command prefix above plus `src/agent-host/server/http-server.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| REWRITE | answers one identical 401 for a missing and for a wrong token | Compare actual missing-token and wrong-token status/envelopes; assert protocol code, remove exact human Unauthorized wording. |
| KEEP | health reports the protocol version and host identity | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | reports live and active-turn threads for the drain-restart | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | routes every §6.2 command and answers `{seq}` | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | maps every rejection to its §6.2 status | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | creates, renames and deletes a thread | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | 404s an unknown item and an unknown turn diff | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | serves a tool call's streamed output joined from the log, and 404s with its own code | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | answers one window of the join when offset or maxBytes asks for it, and the whole join without either | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| REWRITE | refuses a malformed offset, clamps maxBytes, and answers an offset past the end as the end | Retain status, error code, UTF-8 byte window bounds and clamping; remove exact diagnostic prose assertions. |
| KEEP | serves the provider snapshots with the host instance id | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | claims an attachment from a raw octet-stream body and resolves it back | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | serves the §6.4 summary fields the daemon cannot derive from the log | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| REWRITE | names every open request so the daemon can publish agentChat.pending | Assert request ids and approval/question kinds without pinning generated presentation titles. |
| KEEP | answers an unknown route with 404 rather than hanging | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | opens with a snapshot, marks synchronized, then streams live events | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | replays by cursor when the range is small enough | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | two clients converge on the same order (§6.6) | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| DELETE | the intentional stop writes the continuation markers first (§3.3) | Arranges the claimed effect itself by manually marking the orchestrator before calling /stop; harness onStop returns an empty list. Cannot detect production stop ordering. Host-teardown's real stop/restart tests retain durable continuation coverage. Delete its harness-only afterStopResponse option. |
| REWRITE | closes every open stream when the host stops | Await actual HTTP response close after stopping the host, instead of a test-only openStreams counter. Remove that unused production getter/interface member. |
| KEEP | is a 409 COMMAND_REJECTED once the host is up, never a 500 | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | is a 503 HOST_UNAVAILABLE while the host is still cold | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | answers 503 INDEX_UNAVAILABLE for history without a usable index, 404 for no thread | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | stamps the snapshot a thread read answers with its history bounds | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | caps the search query by code point and answers blank queries | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | answers search `indexed: false` with a 200 when there is no usable index | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | lists the thread's prompts from the index, newest first — steers included | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | answers the list `indexed: false` without a usable index, the text 503, and 404 for no thread | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | serves one prompt's whole text, and 404 PROMPT_NOT_FOUND for any other id | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | answers `catchingUp` while the index catches up with a thread, the page once it has, and `indexed:false` for one it never will | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | answers a read that failed with a retryable 503 INDEX_UNAVAILABLE, never an empty page | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | reads a prompt longer than the index keeps back from its own line in the log | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | POST /opencode/recycle-idle answers the OpenCode adapter's counts | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | recycles nothing when no adapter serves OpenCode | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | POST /goals/hold renews the lease and answers every thread held after it | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | POST /goals/resume-sessions takes the threads it knows and refuses a malformed body whole | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |

## `apps/daemon/src/agent-host/server/stream.test.ts`

- Fault model before retaining isolated cases: createThreadStream wire frames and sink closure: event loss/duplication during read, early synchronized frame, missed heartbeat, memory overrun or write after disconnect.
- Non-test callers: host HTTP server thread streams.
- Bar 1 — independent source: GUI design §6.3 snapshot/replay atomic tail and §6.6 framing/coalescing/backpressure; each row below selects its exact behavior.
- Bar 2 — recognizable failure: event loss/duplication during read, early synchronized frame, missed heartbeat, memory overrun or write after disconnect; each named scenario distinguishes the failure it can expose.
- Bar 3 — independent oracle: literal protocol states/codes/bytes, prewritten fixture records, independently controlled external replies, or actual filesystem/process results; expected values are not computed with the production algorithm.
- Bar 4 — stable seam: createThreadStream wire frames and sink closure; no retained assertion requires a private call graph.
- Bar 5 — refactor resilience: equivalent output/state/side effects satisfy these assertions even if internal helpers, storage implementation or control flow are renamed/reorganized. REWRITE rows remove the identified exception.
- Bar 6 — unique lowest ownership / remaining stronger coverage: Lowest streaming owner with an OS-sink fake; it does not implement snapshot overlap selection/queueing. HTTP integration owns socket wiring, not exhaustive scheduled pressure/race cases.
- Risk: retained cases include migration, security, protocol or credible race/OS regressions; deletions remove duplicate or non-observing assertions. Configuration changes are limited to removing test-only exposure, with behavior preserved.
- Validation: command prefix above plus `src/agent-host/server/stream.test.ts`.

| Disposition | Original test / exact required observable behavior | Reason / retained unique failure ownership |
| --- | --- | --- |
| REWRITE | loses no event published while the read is in flight, and duplicates none | Remove private subscription-order flag/assertion. The output sequence already proves no missed in-flight event and no replay duplication. |
| KEEP | pushes `synchronized` after everything buffered, never straight to the socket | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | coalesces live tool updates on the 50 ms window and flushes on any other frame | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | sends `:hb` on the heartbeat interval | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | closes the stream when the undrained write buffer passes its budget | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | releases the charge once the socket drains | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |
| KEEP | stops writing once the client disconnects | Protects the exact named condition at the file’s stable seam; its failure is caller-visible under the fault model above. No remaining test owns this combination of input condition and observable outcome. |

## Production/support removed

- Remove the export on `applyClaudeProjectTrust`; production only calls it inside `markClaudeProjectTrusted`. Writer tests use the same filesystem boundary as AgentChatService.
- Remove `ChatSessionManager.clear`, an explicitly labeled test/teardown helper with only the concurrent-index test caller. Use public close operations in that case.
- Remove `AgentHostServer.openStreams` and its returned getter; only the server shutdown test reads it. Observe the HTTP response close instead.
- Remove the HTTP test harness `afterStopResponse` option used solely by the deleted pre-arranged continuation test. Keep the actual production callback used by main.
- Remove now-unused imports and the empty codeStampsDiffer suite. No provider fixtures or durable snapshots become unowned.

## Validation and completion

Baseline: 299 tests passed, 3 failed (302 executed because two files failed import before registering 39 cases). `owner.test.ts` and `service.test.ts` could not import missing installed dependency `yauzl`; root is reconciling dependencies with frozen lockfile install. The SIGTERM backstop case measured 4805 ms during heavily concurrent host work; it remains retained and will be rerun isolated before judging product behavior. No failing test is deleted for being red.

Cleanup is implemented and its final diff inspected: **12 DELETE, 13 REWRITE, 314 KEEP** across 339 original cases; **327 cases remain**. Test diff: 79 lines added, 277 removed (**net -198 test LOC**). Production exposure cleanup removes 9 net lines; no runtime behavior changes. No fixtures or snapshots became unowned.

Post-edit checks (from `apps/daemon`, using the preload/runner prefix above):

- `src/agent-chat/home-prep.test.ts src/agent-chat/session-index.test.ts src/agent-chat/summary.test.ts src/agent-host/support/code-stamp.test.ts src/agent-host/support/stderr.test.ts src/agent-host/server/stream.test.ts src/agent-host/server/http-server.test.ts`: **96 passed, 0 failed**. Includes the actual HTTP close oracle, authentication equality, preserved config bytes/mode/symlink and concurrent session saves.
- `src/agent-chat/owner.test.ts src/agent-chat/service.test.ts`: **38 passed, 0 failed** after root restored the missing lockfile-declared dependencies with `pnpm install --frozen-lockfile`; no dependency metadata changes.
- `--test-name-pattern='an intentional stop' src/agent-host/host-teardown.test.ts`: **2 passed, 0 failed, 4 deliberately unselected**. Both provider handovers now use authenticated real HTTP `/stop`, observe its acknowledged marked thread, await production `onStopped`, and inspect durable log/meta artifacts after the next host starts.
- `git diff --check` for all owned test/production files and this report: **passed**.
- Original and final AST inventories: 25 files, 339 → 327 named cases; report lists every original case.

Root-review follow-up, recorded before editing the composition case: the original total-stop wall measurement failed at 4805 ms and 4537 ms under heavy shared load, while both runs confirmed that the actual helper was killed. `agent-host/README.md` documents a 1 s helper grace inside the process entry's 3 s SIGTERM backstop. It does not require an in-process `stop()` call, including all log/index/cache flushing and scheduling, to return within 3 s of caller wall time. This test never executed that process-entry timer, so its measured failure did not establish a violated signal deadline or a leaked helper.

The rewritten existing case is named `an authenticated host stop reaps a helper that ignores SIGTERM before reporting completion`: it uses the real authenticated Unix-socket stop route, waits for the same `onStopped` callback that permits the production process to exit, and verifies the real helper is absent. A 15 s watchdog fails a hung teardown; it is test infrastructure, not a replacement product latency oracle. The lower owner `apps/daemon/src/agent-host/adapters/grok/lifecycle.test.ts` retains `at the host's teardown a helper that ignores SIGTERM is killed after a 1 s grace, not spawn.ts's 2 s`: actual TERM and KILL signals reach a spawned helper; a controlled clock asserts exactly 1000 ms between them; helper absence is observed before adapter teardown completion. Host composition now owns route wiring and completed cleanup, and the lower seam owns signal timing. No production backstop or grace was changed. Post-edit validation: the entire `src/agent-host/host-teardown.test.ts` file ran serially with the documented preloads: **6 passed, 0 failed**, including the rewritten helper case and both HTTP handovers (19.1 s total). `git diff --check` passed again. The scoped regression validation is complete; final repository gates remain root-owned.

Repository-wide lint/typecheck/test gates, remote synchronization and commit/push are root-agent responsibilities. This scoped cleanup does not alter package scripts, thresholds, production state or the live daemon.
