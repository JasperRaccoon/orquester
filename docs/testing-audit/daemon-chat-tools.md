# Daemon chat, approval and session-tool audit

Audited 35 files / 607 static test declarations at `beb7516b10a3c4472399e0f6f2f2b0a187a61186`. Outcomes: 2 CONSOLIDATE, 2 DELETE, 583 KEEP, 3 OPTIMIZE, 17 REWRITE. Test LOC: +83/−191, net -108. Parameterized subcases are kept under their source declaration; counts are not runner-expanded test totals.

Tests and their production owners were compared with the local specifications and runtime boundaries. The file evidence supplies all six behavioral-bar criteria for every surviving row; each row names its distinct failure scenario. KEEP does not claim that another layer never mentions the feature: route registration, daemon scheduling, storage, provider protocol and client interpretation own different failures. No deleted contract relies on a mock of that same asserted behavior.

## Cleanup and cost

- Deleted private LRU-capacity policy coverage and the manually assembled fork pseudo-integration. Actual Fastify principal gates, executor self-fork and service lineage/ownership cases survive.
- Consolidated signer expiry into its minted-URL lifecycle and secret-answer parsing into actual HTTP answer coverage.
- Removed `orquesterInstructionsCap`, its declaration-only 2048-byte constant, exported internal knowledge/refresh/image caps, the signer lifetime alias, signer key/time injection, four unused secret-registry injection options and the private parser export. Actual production callers use the same default behavior. No package dependency, fixture directory or snapshot became orphaned.
- Kept descriptor-level `openInsideRoot` security coverage: the realpath→open race cannot be proven by a successful public publish alone. This is the stable filesystem containment boundary; it is production-used, not a fake outcome hook.
- Kept deterministic receipt/drain synchronization required by durable asynchronous owners. Removed incidental ID-generation order and arbitrary gzip compression-ratio assertions.
- Reduced page-size fixture from three sparse files to one reused image; retained actual 25 MiB aggregate enforcement. No runtime speed claim is assigned to this small fixture change without comparable measurement.

Baseline profiling used Node 24.22.1, 4 test-file workers, `TSX_DISABLE_CACHE=1`, one package at a time. The slowest scoped behavior was the actual 500 MiB upload cap through MCP: **903.24 ms**. It stays because cheap typed-error mocks do not exercise real streaming cap enforcement. Its fixture already reuses one 1 MiB source buffer and discards received chunks. Next examples: upload HTTP mapping 266.39 ms, authenticated routes 236.12 ms, profile create 230.51 ms; these include actual server/socket/config initialization.

The unconfirmed-secret case spent **12.04 ms** on the baseline, including a real 5 ms delivery wait. It now advances a built-in virtual clock through the real 30-second bound. Total-suite comparisons and final status belong to the root integration report; no CI speedup is inferred from these individual samples.

## Validation

No agent-local test run was started, to preserve the one-test-run-per-worktree rule. Each JSON entry records its exact focused command. Root will run the combined affected target plus typecheck/full gates. `git diff --check` was inspected; an unrelated scripts test had trailing whitespace owned by another agent. Own edited files had no whitespace errors.

## Six-part evidence and declaration dispositions

### apps/daemon/src/agent-chat/activity-ladder.test.ts

- **Independent contract/source:** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §6.4; docs/superpowers/specs/2026-09-24-agent-goals-design.md §4.7
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Literal documented activity and push states; fixed conflicting fields establish precedence.
- **Stable seam:** resolveChatActivity / pushTypeForFields: summary fields → activity/attention/push kind
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Lowest owner of the shared priority rule. Summary tests cover polling, stamps and transport wiring; they do not exhaust the independent precedence and race combinations.
- **Production callers:** summary.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 16: rung 1: a pending approval outranks everything | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 29: rung 2: a pending question outranks the session state | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 39: rung 3: a failed session outranks lingering background liveness | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 50: rung 3: a failed TURN is an error even with a ready session | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 58: rung 4: starting is working | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 65: rung 5: a running session or a running turn is working | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 81: rung 6: an actionable plan on a settled turn is waiting + needs-input | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 94: rung 6 outranks background working and monitoring | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 110: rung 6 sits BELOW approval, question, error and a running turn | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 133: rung 6 needs a SETTLED turn: no turn, or one still open, is not plan-ready | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 149: rung 7: background liveness `working` keeps the thread working after the turn | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 160: rung 8: monitoring is idle WITHOUT a finished stamp | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 171: rung 9: a completed turn is idle + finished | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 181: race fallback 1: `interrupted` WITH a completedAt is finished | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 192: race fallback 1 does NOT fire without a completedAt | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 201: race fallback 2: a live `ready` session with nothing pending is finished | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 209: an empty summary resolves to nothing rather than to finished | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 216: attention pushes follow the protocol state and remain silent while work is active | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 231: a plan-ready thread pushes even while background work is live | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 249: a continuing goal keeps a settled turn from reading as finished | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 267: a continuing goal also covers both race fallbacks | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 281: a failed TURN alone does not end a continuing goal — the goal's own status does | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 301: an errored session is an error unless the HOST says the goal still continues | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 322: a continuing goal never outranks the user or a running turn | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 339: a continuing goal outranks a plan prompt and lingering liveness: the thread is working | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 359: a goal that is not continuing changes nothing | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 371: never a `finished` push while background liveness is non-null | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |

### apps/daemon/src/agent-chat/chat-sessions.test.ts

- **Independent contract/source:** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §5.2, §6.1, §6.4; docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md §6
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Fixture IDs/accounts/lineage and literal event/persistence results.
- **Stable seam:** ChatSessionManager and ChatAwareSessionManager: session list, records, lifecycle
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Owns chat-vs-PTY routing, mixed tab order and durable session records. Host tests cannot detect daemon tab metadata loss.
- **Production callers:** service.ts; session-router.ts; index.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 30: a created chat tab round-trips through its sessions.json record | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 52: one bad chat record never poisons the index | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 106: a chat record without a chat block is skipped, not resurrected as a half-thread | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 123: closing a tab queues a DURABLE host-side delete | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 148: a malformed queued id is dropped, never the whole queue | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 154: lastSeq is monotonic — a stale frame cannot rewind a tab's cursor | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 168: the derived §6.4 fields publish only when one actually moved | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 180: a delegated child's view rides the tab: republished when its model or preview text moves, cleared with null | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 202: the goal rides the tab and republishes only when it moves (goals §4.7) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 325: the tab strip is one list over both kinds, sorted by the shared order | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 337: reorder spans both kinds: a chat tab dragged between terminals lands there | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 350: closing a chat tab cascades the host thread delete BEFORE forgetting it | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 358: renaming a chat tab appends the host's thread.meta-updated | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 366: a managed-hook agent-event for a CHAT session is accepted and ignored, never 404 | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 376: the PTY-only surface is inert for a chat tab | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 388: setAccount moves the summary AND the persisted chat block together | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 414: switching to the system identity drops the summary's account id | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 423: a child tab's lineage round-trips through sessions.json; an old record has none | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 460: pending merges ride the summary, announced only on a change and never persisted | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 482: a chat running through an Agent Profile home still pins its account for the idle-account refresher | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 492: a chat's usage-limit state is persisted on its record, keeps a newer daemon's fields, and clears with an explicit null | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |

### apps/daemon/src/agent-chat/delegates.test.ts

- **Independent contract/source:** docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md delegate cancellation; docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md session lifecycle; documented stop cascade in delegates.ts
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Explicit tree includes finished delegates, nested delegates, forks and opened chats; expected interrupted IDs and causes are literal.
- **Stable seam:** DelegateStopCascade: accepted/requested stops and daemon command effects
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Lowest owner of descendant selection and stop/reply ordering. Proxy tests prove registration and forwarding, not graph traversal.
- **Production callers:** service.ts; proxy-routes.ts; replies.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 117: tells the reply router every delegate link of the stopped tree before any interrupt — even with nothing left to interrupt | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 143: holds replies to a chat while its stop is on the way, never for the cascade's own interrupts | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 159: a router that fails to record the stop never keeps the children running | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 167: interrupting a parent interrupts its unfinished delegates, recursively — never forks, opened chats or finished ones | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 181: is idempotent: a repeat of the same stop posts nothing twice, and the cascade's own interrupts start no cascade | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 201: starts nothing for a housekeeping interrupt (cascade: false — usage-limit recovery clearing a parked turn) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 212: skips delegates that already finished, and does nothing for a chat with no delegates | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 228: stopping a child (control_session) cascades to that child's delegates only | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 237: closing a parent cascades with the title it had, read before its record goes | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 246: does nothing before the daemon's API is bound, or once stopped | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |

### apps/daemon/src/agent-chat/home-prep.test.ts

- **Independent contract/source:** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md launch preparation; AGENTS.md secret and symlink preservation rules
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Literal CLI trust keys, 0600 mode and pre-existing credential/unknown blocks.
- **Stable seam:** markClaudeProjectTrusted → actual temporary config file and permissions
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Owns safe credential-bearing config writes; launch tests only establish which confined path reaches this writer.
- **Production callers:** service.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 12: a malformed projects map is replaced rather than crashing the launch | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 24: markClaudeProjectTrusted writes 0600 and survives an absent file | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 42: a pre-existing 0644 config is NARROWED to 0600, never left wide | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 65: a symlinked config is written THROUGH, never replaced by a regular file | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 84: an unwritable config never fails a launch | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |

### apps/daemon/src/agent-chat/host-client.test.ts

- **Independent contract/source:** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §6.3; upload-stream.ts typed cap refusal boundary
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** A deliberately failed readable must reject with HOST_UNAVAILABLE while preserving the exact typed cause; unrelated errors classify false.
- **Stable seam:** AgentHostClient.open against a real temporary Unix socket
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Only this test exercises a source error before response headers through the real HTTP client. Service/MCP mapping tests alone cannot prove cause preservation.
- **Production callers:** service.ts; proxy-routes.ts; summary.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 17: a body that fails before the host answers rejects as HOST_UNAVAILABLE, carrying the body's own error as its cause | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 50: upload cap classification does not mistake timeouts, cancellation or message text for a size refusal | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |

### apps/daemon/src/agent-chat/html-render-publish.test.ts

- **Independent contract/source:** docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md §2.1–2.2; AGENTS.md realpath/secret containment
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Literal input bytes, actual confined/escaped files, fixed public 10/25 MiB bounds and exact refusal codes.
- **Stable seam:** publishHtmlRender and filesystem descriptor containment boundary
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Owns preparation, image containment and post-realpath race refusal. API bootstrap tests lack filesystem access; route tests lack this preparation owner.
- **Production callers:** service.ts; html-preview/index.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 52: publish stores the page with the bootstrap and answers the reference | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 68: measure runs on the prepared page when no heights were given; a throw publishes without | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 95: a call cancelled while its page was measured stores nothing | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 115: a local image inside the project is inlined as a data URI | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 130: an image outside the project is refused, symlinked in or not | REWRITE | Fix false-positive no-project refusal: use a real existing valid image and require images-outside-project, rather than accepting missing-file failure. |
| 152: a missing image, or a file that is not an image whatever its name, is refused | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 165: an image over 10 MiB is refused | REWRITE | Use independent documented 10 MiB + 1 byte fixture instead of importing the production limit, so changing the limit incorrectly is caught. |
| 176: a page over 25 MiB once its images are inlined is refused | OPTIMIZE | Use one sparse 7 MiB image referenced three times instead of three separate files. Public inlined page still exceeds 25 MiB and is refused; fewer fixture writes/stats with no mocked cap. |
| 197: an empty or oversized page, or a store failure, is refused with a code | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 223: image sniffing reads magic bytes and SVG roots, not names | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 241: an image path swapped for a symlink after its realpath was checked cannot be read | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 264: a FIFO in an image's place never blocks the open: refused at once, not waited on (S-M2) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |

### apps/daemon/src/agent-chat/idle-compaction.test.ts

- **Independent contract/source:** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md idle-compaction contract; packages/api/src/agent-chat/idle-compaction.ts documented cache policy
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Manual clock and literal command IDs, guard combinations and user preference transitions.
- **Stable seam:** ChatIdleCompaction: candidates/preferences/lifecycle → compact commands
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Owns scheduling, cancellation and restart command identity. API rule tests alone cannot detect timers posted twice or surviving closure.
- **Production callers:** service.ts; summary.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 170: a 1h cache is compacted two minutes before it expires, once, under the turn's command id | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 191: a 5m cache is compacted at minute 3 | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 200: only 'before the cache expires' compacts; an account's override wins over the default | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 218: never another agent's chat | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 226: each guard on the tab keeps it from compacting | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 251: a guard that clears inside the window lets it go out; one that appears cancels it | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 275: the user sending (a new turn) cancels the timer, and the next turn's own window replaces it | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 294: closing the tab or turning the setting off cancels it | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 320: a restart re-arms from the host's candidate alone; one inside the window fires at once, one past it never | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 348: no double compaction: a restart in the window re-posts the same command id, which the host answers from its receipt | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 364: an unavailable host is tried again until the window closes; a refusal waits for the chat to change | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 384: before the daemon's API is bound it waits; binding it sends a compaction that came due | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 394: the summary's candidate is validated field-wise | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |

### apps/daemon/src/agent-chat/limit-recovery.test.ts

- **Independent contract/source:** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md usage-limit recovery; packages/api/src/agent-chat/usage-limit.ts public recovery state
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Fixed provider reset timestamps/accounts; literal state/outcome/command identities, with independently observed retry equality.
- **Stable seam:** ChatLimitRecovery: notices/actions/restart → persisted state and daemon commands
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Owns actual recovery scheduling and account transitions. API parser/config tests do not execute recovery or preserve action IDs across restart.
- **Production callers:** service.ts; limit-recovery-routes.ts; summary.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 199: a limit with a provider reset is recorded, armed and cools the account down | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 215: at the reset plus the margin the continue message goes out, under the idempotent command id | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 234: a resume that hits the limit again re-arms with the new reset | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 249: the same limit seen again (a later row of the same turn) keeps the user's choice | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 261: no reset from the provider: the usage reading's reset of the burnt window is used | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 280: no reset known at all: limited, never scheduled; an old one or a past reset is history | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 302: skip rules: the user writing, a pending approval, a cancelled resume, a closed chat, a busy chat | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 339: the host restarting at the resume retries it later, under the same command id | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 352: re-arm after cancelling, and the setting turning off disarms every armed chat | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 376: boot: a persisted schedule is rebuilt, and a reset that passed while the daemon was down resumes at once | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 394: boot: an action cut short by a restart runs again under its own command id (receipts dedupe it) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 410: failover (opt-in): moves to the least-used other account and continues with the workflows' message | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 423: failover with every other account cooling down falls back to the resume at the earliest reset | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 437: never fails over for OpenCode: it only resumes | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 445: manual switch and resume now: idempotent by the client's command id, refused when nothing is limited | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 463: a parked turn is interrupted, and the resume waits for it to settle on the bus | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 480: workflow-owned chats are left to the workflow engine | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 498: command ids stay within the route's bound | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 505: the summary's usageLimit is read tolerantly | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |

### apps/daemon/src/agent-chat/lineage-routes.test.ts

- **Independent contract/source:** docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md §6; docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md §8.3 and principal gates
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Literal status/error codes, user-supplied bodies and independently chosen principals.
- **Stable seam:** Real registered Fastify lineage/reply routes via inject
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Owns wire status mapping, principal stripping and socket-only registration. Service tests bypass HTTP registration and cannot detect these failures.
- **Production callers:** index.ts; service.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 36: the three routes answer on agentChatRoutes' paths | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 52: refusals keep their code and words; anything else is a generic rejection | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 83: a pending merge is acted on by its id, from a tab that may already be closed | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 99: a refusal whose code is not on the wire list (SESSION_UNAVAILABLE) answers 409 COMMAND_REJECTED, as documented | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 142: lineage.agentCreated on session create survives only from the parent's own agent (principal-gated) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 166: ForkSessionRequest.agentCreated survives only from the forked chat's agent; merges only as oneself | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 184: a merge past the exchange cap answers 409 EXCHANGE_LIMIT | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 197: the reply-subscription routes exist only where registered (the unix app), and answer the router's refusals | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 231: Deliver now refused while the target works answers 409 TARGET_BUSY | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |

### apps/daemon/src/agent-chat/lineage.test.ts

- **Independent contract/source:** docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md §6; docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md §8 and persistence/retry rules
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Literal queued/delivered/refused states, command IDs and persisted fields; explicit failure/race setup.
- **Stable seam:** LineageService using DaemonApi and real temporary durable outbox
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Owns ordered merge delivery, retries and tolerant outbox writes. Reply tests focus subscription ownership rather than these merge/store contracts.
- **Production callers:** service.ts; lineage-routes.ts; replies.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 223: is false while anything runs or waits on the user | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 236: sends the child's final reply to an idle parent at once, marked as coming from the fork | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 252: a merge from a planning turn reaches the parent in plan mode, sent at once or queued and persisted | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 274: a merge keeps a planning parent in plan mode — sent at once or delivered later (D-I1) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 299: never answers queued for a merge it could not save: refused, nothing left queued (D-M1) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 312: a corrupt outbox, or another version, is moved aside and never overwritten (D-I2) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 324: an unreadable outbox makes merges that would queue refused for the run, the file left alone (D-I2) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 334: unknown top-level keys and entries of a newer build survive a rewrite (D-I2) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 347: drops a merge once its parent and its fork are both closed — never while either is open (D-T2) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 365: sends the user's own summary instead when given one | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 372: queues for a busy parent, persists it, and delivers it on the parent's next idle point | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 408: keeps a queued merge across a restart, and a host restart, until delivered | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 433: keeps a merge whose parent was closed as failed — said, never dropped — and entries it cannot read | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 458: the host's deadline refusal is retried under a NEW command id, once its retry delay has passed | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 486: three deadline refusals a delay apart fail it; Retry then delivers under a fresh id | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 512: a deadline refusal of a merge sent at once queues it rather than refusing the caller | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 529: only the deadline is a refusal of the moment: any other COMMAND_REJECTED, or COMPACTION_UNAVAILABLE, fails at once | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 548: a caller's merge id is refused, never replaced: too long, blank, or holding the retry separator | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 562: a refusal that will not pass fails it at once; a 503 re-posts the SAME id | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 578: a discard that races a delivery answers what happened: sent | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 592: delivers now, past a parent a continuing goal keeps busy — one message, steering the turn | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 611: a merge to an idle parent with an older one queued waits behind it, oldest delivered first | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 629: serializes concurrent merges to one idle parent, so neither steers into the other | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 650: refuses a session with no parent, a closed parent, and a child with nothing to say | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 664: resolves once a queued merge's delivery lane and its outbox writes are done | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 681: names the parent and lists the children oldest first, with their status | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |

### apps/daemon/src/agent-chat/ndjson-forward.test.ts

- **Independent contract/source:** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §6.3; RFC 9110 §12.5.3; packages/api NDJSON heartbeat protocol
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Literal accepted/refused headers and expected heartbeat/data bytes under a controlled clock.
- **Stable seam:** Accept-Encoding parser and NDJSON transform stream
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Lowest owner of wildcard/q=0 negotiation and mid-line heartbeat safety. Real streaming proxy tests do not force partial-line idle boundaries.
- **Production callers:** proxy-routes.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 9: gzip is accepted by name or wildcard, never at q=0 | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 30: a heartbeat goes in only between lines, and only after the idle time | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |

### apps/daemon/src/agent-chat/owner.test.ts

- **Independent contract/source:** README workflow/knowledge worker ownership; workflow design §5.10; packages/api owner wire contract
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Explicit workflow/knowledge owner records, extra fields and invalid owners; literal response codes and service input.
- **Stable seam:** POST /api/sessions through actual createServer registration
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Only full route owner tests catch dropping/filtering owner metadata before service invocation. Service storage tests prove a different downstream boundary.
- **Production callers:** index.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 77: POST /api/sessions hands a valid owner to the chat create and returns it on the summary | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 93: POST /api/sessions refuses a malformed owner with 400 INVALID_OWNER before anything is created | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 108: POST /api/sessions refuses an owner on a terminal tab | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 122: POST /api/sessions keeps a knowledge-indexer owner on the chat it creates | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |

### apps/daemon/src/agent-chat/provider-auth-overlay.test.ts

- **Independent contract/source:** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.7 managed-account provider authentication
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Literal authenticated/unauthenticated/ready/error results from distinct-family and reauth fixtures.
- **Stable seam:** overlayManagedAccountAuth: provider probe + accounts → reported authentication
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Lowest owner of system-probe override policy. Adapter authentication tests have no managed account list and cannot supersede these outcomes.
- **Production callers:** service.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 33: a stale system login is covered by one valid managed account | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 40: stays unauthenticated when every managed account needs re-auth | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 45: only the provider's own family counts | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 50: opencode has no account family and is left alone | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 55: an authenticated probe is returned as-is | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 60: an error that was only the missing login becomes ready, message dropped | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 70: a non-auth error keeps its status and text | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 79: prefers the family default account for the label | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |

### apps/daemon/src/agent-chat/proxy-routes.test.ts

- **Independent contract/source:** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §6.2–6.3; docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md §2.2/§3/§6; thread-index/lazy-boot design
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Literal paths/status envelopes, chosen request/query bytes and independent streamed payloads; actual decompression.
- **Stable seam:** Registered Fastify proxy routes → real temporary agent-host Unix socket
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Owns daemon↔host hop, authentication, allowed query keys, old-host fallback and cancellation. Host handlers and API helpers cannot detect a broken proxy.
- **Production callers:** service.ts; index.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 148: documented commands preserve their path, body, authentication and acknowledgement | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 166: an accepted interrupt or stop is reported to the delegate stop cascade; a refused one, or any other command, is not | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 186: a stop opens its hold before it is forwarded and closes it after the cascade heard it — accepted or refused | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 213: the host's error envelope is passed through verbatim, status included | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 232: an unknown session is 404 THREAD_NOT_FOUND and never reaches the host | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 245: a down host is 503 HOST_UNAVAILABLE on commands, reads and the stream | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 270: an unreachable host socket is 503, not a 500 | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 283: a non-JSON body from the host is a 502, never leaked raw | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 296: a tool call's streamed output is proxied verbatim — the host's own 404 and an older host's route miss alike | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 332: a window of a tool call's streamed output forwards offset/maxBytes verbatim, and passes the window through | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 359: a malformed turn count is rejected before the hop | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 368: a thread read records the sequence it served (§5.2 lastSeq) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 380: a thread read passes the window it asks for on to the host | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 395: an events-shaped read records its sequence too | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 406: a refresh broadcasts agent.providers.changed ONLY when it changed something | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 423: attachment reads reject missing IDs, unknown tabs and unavailable hosts | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 438: the host-stop route drives the supervisor's drain restart | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 453: the host-status route answers the supervisor's pending-restart view, and 404 without one | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 480: the stream is piped through, and the client disconnect cancels the upstream | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 519: a client that accepts gzip gets the stream gzipped, each line flushed as it is written | REWRITE | Remove arbitrary 4x compression ratio and byte-count instrumentation; retain real gzip negotiation/decompression and complete independent lines decoded while source still open. |
| 556: a client that does not ask for gzip gets plain NDJSON, every byte through the host's end | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 575: a gzipped stream the host ends is ended with its trailer, nothing lost | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 594: a stream refusal answers the host's envelope rather than an empty stream | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 608: the account route is daemon-owned: it never hits the host socket itself | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 622: the account route is 404 for an unknown tab and 503 while the host is down | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 642: a daemon-side refusal answers the §6.2 status of its code, INDEX_UNAVAILABLE included | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 673: the profile route is daemon-owned like the account's: 404, 503, the receipt, and refusals mapped | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 729: a history read forwards before/turns verbatim and passes the page through | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 751: a history read with no query asks the host for the page below the window | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 763: a history read for an unknown tab is 404 THREAD_NOT_FOUND and never reaches the host | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 772: a search forwards q/limit/projectPath verbatim, and only those | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 821: the host's INDEX_UNAVAILABLE 503 passes through verbatim on history and search | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 840: a host that predates the index (404 on /search) answers the unavailable search shape | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 901: a prompts read forwards before/limit verbatim, and only those, and passes the page through | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 922: a prompt's text is proxied with its id kept one encoded segment | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 941: prompt reads for an unknown tab are 404 THREAD_NOT_FOUND and never reach the host | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 952: every prompt-read 404 passes through untouched — the host's own and an older host's route miss | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 989: the host's `indexed:false` page and its INDEX_UNAVAILABLE 503 pass through verbatim | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1024: a page URL is minted only for a known tab and a published page's id | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1047: a signed page is served under the sandbox CSP; a bad signature never reaches the host | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1089: a signed page whose file is gone, or whose host is down, is refused plainly | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1103: an MCP App's request is forwarded to the host with its row, and refused before the host when it cannot be one | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1182: a head read is the host's own head, its query forwarded, its seq noted | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1195: an older host's route miss: the head is derived from its snapshot, and that host instance is not asked again | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1220: a head the host refuses for its own reason passes through, never falling back; an unknown tab never reaches the host | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1236: a route miss is remembered only for a host instance adopted before AND after the answer | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1257: a head lookup past the cap is refused 400 INVALID_COMMAND, before the host is asked | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1270: a profile chat's catalog is its live session's report, else the profile's own items — a Global chat's is none, without asking the host | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1318: a profile chat with no profile catalog to offer — or one that fails — answers its profile's, empty: never none (the provider's Global) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1343: the on-demand opt-in passes through on both reads, and only its one value | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1372: POST agent-rows is forwarded to the host as it is, and its answers come back verbatim | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |

### apps/daemon/src/agent-chat/replies.test.ts

- **Independent contract/source:** docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md §8.3–8.4, §13 d–e; documented retained crash/release/stop regressions
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Explicit messages, turn IDs and selected interleavings; literal delivery/state counts, saved ownership and fixture reply bodies.
- **Stable seam:** ReplyRouter + real LineageService with actual temporary durable outboxes; DaemonApi host boundary
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Lowest owner of waiter/router arbitration and durable delivery recovery. MCP tool mocks and standalone merge tests cannot protect these distinct interleavings.
- **Production callers:** service.ts; lineage-routes.ts; lineage.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 506: persists the subscription BEFORE the message is posted, and binds the turn it caused | REWRITE | Remove incidental id-generator call order assertion id-2; durable pre-post write, exact propagated command identity and actual caused-turn binding remain. |
| 528: queues — never steers — a message to a working target, and replies with THAT turn's answer only | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 556: binds through a retried post: the attempt that landed, found by its own command id | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 577: resolves once the evaluation a settled turn starts, its delivery and every write are done — no event-loop counting | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 597: a message the idle target refuses for good is taken back: the sender hears it, nothing stays queued | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 608: router first: the attached waiter gets the reply, and nothing is delivered | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 626: timeout first: the waiter returns notify, and the reply is delivered once as a message | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 643: the edge: settle and timeout in the same tick — exactly one consumer, either way | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 673: needs-input: the waiter returns early and the subscription stays notify; the reply follows | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 689: a wait that would close a cycle is WAIT_CYCLE; only the requester may wait | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 705: an empty final reply delivers the §13 d text; a waiter gets emptyReply and no reply | REWRITE | Remove expected text computed from production formatter; retain independently specified literal §13 d message, delivery outcome and waiter emptyReply protocol. |
| 727: a failed or interrupted bound turn delivers its state and error | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 744: a target closed first delivers 'closed before replying' (a waiter hears closed); a requester closed first drops it | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 779: a queued message the target's user discards tells the requester; one the requester takes back does not | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 802: hop: a message carries its own, a reply the replying turn's + 1; past the cap the delivery says so | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 819: a merge back carries its causedBy, and one past the cap is refused | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 829: caps pending subscriptions per requester, honours an idempotency key, and refuses another principal | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 847: waiting becomes notify on load; a turn that settled while down is delivered exactly once | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 868: an open wait survives a restart as notify (no waiter outlives the process) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 879: a claimed-by-router subscription is resumed, not claimed again: its delivery re-posts under its id and the receipt dedupes | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 934: a subscription whose message never reached the queue is dropped at boot | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 956: a released waiter is never handed the reply: it is delivered as a message instead | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 975: release racing the router's claim: exactly one consumer — the reply is delivered, never lost | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1001: a requester closed while it waits: the wait ends 'closed' and its registration is released | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1016: Deliver now on a queued message while the target works is refused TARGET_BUSY and stays queued | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1026: the idle-check race: the host's ifIdle refusal keeps the message queued (no attempt counted), posted at the next idle point | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1044: an older host steers anyway: the requester gets 'joined a running turn', never that turn's reply | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1062: the claim and its delivery record are one write: on disk together before the reply is posted | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1084: a claimed-by-router subscription with no delivery record (an older build's crash) is delivered once | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1105: a wait that would close a cycle is refused at subscribe, with nothing saved or queued | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1118: a reply that settled before the waiter attached is returned to it (taken back from the queue), not delivered | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1135: a bound turn rewound away ends with a notice and frees the slot | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1147: the fallback match needs the message's own text: a reply-none turn of the same hop is never taken | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1173: a subscription past its maximum age ends with a notice | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1186: a sessions event that moves nothing in the target's summary reads no thread | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1201: merge-back causedBy must name the merging session | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1209: the hop carries on through deliveries and resets only on a user turn | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1227: a delivery queued behind the requester's own user turn keeps its causedBy | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1249: a bound turn that left the snapshot's window is looked up in the history, not declared lost | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1272: Deliver now on a message no reply waits for may steer as before (only reply-bound messages are TARGET_BUSY) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1292: the fallback match compares the trimmed text the host stores | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1313: a second wait after a take-back answers truthfully: the same reply, and no message follows | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1329: a take-back whose queue write fails leaves the reply queued, delivered without a restart | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1362: a bound turn posted after the window's oldest turn and missing from it is lost at once — no history read | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1377: an inconclusive history lookup backs off instead of re-reading pages on every look | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1414: expiry drops the still-queued message: it never runs after the requester was told no reply comes | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1433: a release before the waiter attached: the late wait answers notify at once, and the reply is a message — never claimed-by-waiter | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1448: a reply the waiter took, whose call never got it (released after): re-delivered as a message, once | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1467: a reply taken back from the queue for a late waiter, then released: put back and delivered | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1487: the tombstone and the re-delivery are one write: a crash before the hand is delivered once by the restarted router | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1514: a reply that cannot be read again is recorded: a later wait says so truthfully, never willNotify | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1536: a waiter released while its take-back reads the reply never receives it: the reply stays a message | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1564: a host re-sending the same call gets the reply again; the first call's lost result then delivers nothing — exactly one holder delivers | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1589: a release that lands while a re-sent call's answer is read: that call answers notify, and one message goes out | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1617: a transient read failure is retried by the safety re-check, and the reply is then delivered once | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1647: after a daemon restart the old holder's call is gone: a re-sent call's lost result still delivers exactly once | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1675: a look skipped while the history lookup backs off is no failed read: only lookups that ran count toward giving up | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1708: a target closed after its reply was taken: a re-sent call and the re-delivery still carry the reply text | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1734: a target closed after replying whose reply can no longer be read: the notice says it replied, never 'closed before replying' | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1759: a release that lands while the history lookup backs off is saved: after a restart the reply is re-delivered exactly once | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1796: a wait on a taken reply whose target closed and whose reply is gone: a truthful failed answer, never a hand-out | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1826: a re-check with every message still queued reads nothing | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1842: while the bound turn runs, the router's re-check and a wait's attach read the target's head, never its snapshot | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1881: delivers one short notice naming the child, quoting the question and saying how to answer — once per request id | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1914: queues the notice while the parent is mid-turn (never lost, never steered), and takes it back if the user answers first | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1943: survives a restart through the outbox: a queued notice is delivered once, and an announced request is not noticed twice | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1962: re-hands a notice whose queue write never landed (a crash between the two writes), under the same id | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1980: respects the exchange-hop cap: past it the notice says so and causes nothing further | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1991: wakes nobody for a chat that is no delegated task | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 2030: an idle parent stopped by the user gets no 'interrupted before it replied' turn | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 2046: a session/stop does the same | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 2054: a parent waiting in wait_for_session returns at once, told the task stopped with it, and is not woken after | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 2069: a delegate the user stops directly, its parent left alone, still reports back | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 2080: deliveries already waiting when the Stop lands are not posted: a notice is dropped, a reply is held for the user | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 2117: a message still queued for the delegate is taken back, so the stop sticks below too | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 2135: the stop runs down the whole tree: a grandchild's notice wakes neither chat | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 2150: a reply being handed over when the Stop lands is held, never posted (the hand-off race) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 2172: an attention notice being handed over when the Stop lands is dropped, never posted | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 2189: a delegate that finished just before the Stop keeps its reply: held for the user, never lost | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 2209: after a stop, a wait on a reply still to come says it will be held for the user, never that it comes as a message | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 2226: while a stop is on its way to the host, replies to that chat wait; a refused stop lets them go | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 2240: a stop the host takes in that window marks the reply before it can be posted | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 2254: without the stop's own record, the cascade's row on the interrupted turn still keeps the parent asleep | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |

### apps/daemon/src/agent-chat/secret-requests.test.ts

- **Independent contract/source:** docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md §5 Secrets; session-tools/README.md request_secret delivery and privacy
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Chosen secret sentinel, literal result/state/error codes, independent 10-minute/30-second deadlines and fixed createdAt.
- **Stable seam:** SecretRequestRegistry and registered Fastify answer routes
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Owns exactly-once handoff, secret-free bus/HTTP/log outputs and delivery acknowledgement. Host redaction tests begin after the registry has returned and cannot detect route leaks.
- **Production callers:** index.ts; session-tools/route.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 41: hands the value to the waiting call, once, and publishes only the request | REWRITE | Use real request IDs and independent fixed timestamp through built-in controlled Date, removing copied createdAt oracle and newId/now production hooks. |
| 71: only the asking thread can answer its card | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 83: declining and the call ending each close the card | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 109: the deadline closes a card nobody answers | OPTIMIZE | Use virtual timers at actual 10-minute public boundary; pending one millisecond before, timed_out at the boundary. Removes timeoutMs production seam. |
| 125: a provided answer the call can no longer hand over is reported not delivered, and the card closes cancelled | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 143: and is reported provided once the route handed the result over | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 155: a result that has not left the daemon within the bound is reported unconfirmed, never not-delivered | OPTIMIZE | Use virtual 30-second delivery deadline, removing real 5ms wait and deliveryBoundMs production seam; outcome remains unconfirmed while call receives secret. |
| 195: lists the thread's cards and takes an answer without ever echoing it | REWRITE | Absorb only unique decline outcome from parser-only test into actual HTTP lifecycle. Chosen secret must reach provide call unchanged and never reach declined result, response or logs. |
| 239: refuses a malformed answer without quoting it, and keeps the card | REWRITE | Absorb scalar/null JSON rejection from parser-only test at actual HTTP seam: all invalid shapes return 400 INVALID_ARGUMENT and leave the card pending without echoing secrets. |
| 269: an answer the agent stopped waiting for is 409 SECRET_NOT_DELIVERED, never echoed | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 286: parses exactly the two answers | CONSOLIDATE | Parser-only checks duplicate real HTTP provide/whitespace/malformed cases. Unique decline and scalar/null normalization move into the retained HTTP answer lifecycle, which checks a chosen supplied secret never reaches the declined result. Survives in secret-requests.test.ts lists the thread cards / malformed answer routes. |

### apps/daemon/src/agent-chat/service-boxes.test.ts

- **Independent contract/source:** README box-project chat behavior; ephemeral-box design §7/§8.5; host-protocol.ts box sync wire contract
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Explicit box location/account/capability fixtures and literal launch fields/refusal codes/auth outcomes.
- **Stable seam:** AgentChatService + real temporary host socket; registered box-sync route
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Owns daemon box launch selection and host sync-route validation. Box adapter tests start after this metadata has crossed the daemon.
- **Production callers:** index.ts; service.ts; agent-host/boxes/daemon-client.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 136: a chat of a box project tells the host where its CLI runs: relay socket, the box's facts, its tooling | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 154: a box chat is refused, and no tab is created, for the System account, an old host, an unconnected or destroyed box | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 173: a turn in a chat whose box was destroyed since is refused (409), never forwarded to wait for a CLI that cannot start | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 200: the agent host's box sync route: its bearer only, field-wise bodies, each op to its seam | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 248: the box sync route's turnStarted: a sync without the optional hook still answers 204 | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |

### apps/daemon/src/agent-chat/service-profiles.test.ts

- **Independent contract/source:** README Agent Profiles; Agent Profiles design §4.8/§5.5; host protocol launch-profile contract
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Explicit contributions, accounts, deleted/not-ready outcomes, persisted tab records and literal protocol payloads.
- **Stable seam:** AgentChatService launch/profile/account methods + temporary host socket and profile-refresh route
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Owns daemon application of profile contributions, unattended failure and tab-host reconciliation. Preparer tests alone cannot protect profile selection or loss after a host response.
- **Production callers:** index.ts; proxy-routes.ts; profile-launch-route.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 211: a create with a profile applies its contribution, sends it to the host and records it on the tab | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 231: the composer's fallback catalog is the chat's profile's, for the chat's agent; none for Global or a gone profile | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 241: a create without one is Global: no profile on the wire, null on the summary | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 252: a create naming a profile that is gone or not ready fails with the profile's code, and opens no tab | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 266: a profile is refused while the host does not run profile threads, or before profiles are wired | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 282: an unattended create persists the flag on the tab record | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 290: a fork inherits the parent's profile under the parent's account unless the request names one | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 313: a fork of a chat whose profile was deleted goes ahead interactively as Global with the notice, never unattended | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 339: a fork's reconcile re-sends the child's profile with confirmOnly | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 352: an account switch sends the profile prepared for the NEW account; a deleted one is left to the refresh | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 378: a profile switch resolves the profile, switches the host with it, THEN records it on the tab | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 403: a profile switch is idempotent by commandId; a reused id with another profile conflicts; a refusal moves nothing | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 444: a reused commandId the host answers with another profile (a receipt this daemon forgot) conflicts, and the tab mirrors the host | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 465: the refresh at a session start answers the current version, or the deleted profile's fallback with its notice | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 487: the refresh never falls back for an unattended chat, and passes every other refusal through | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 508: the leases are the host's live prepared dirs, and unknown (a rejection) whenever the host cannot say | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 518: the refresh realigns the tab with the account the host's thread names (an account switch whose answer was lost) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 534: onHostHealthy fires when a host becomes healthy (the leases are knowable again), not on every health tick | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 564: the host's refresh route is the host's alone, and maps each answer to the status the host reads | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |

### apps/daemon/src/agent-chat/service.test.ts

- **Independent contract/source:** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md launch/accounts/restart/upload contracts; docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md lineage/HTML; docs/superpowers/specs/2026-09-24-agent-goals-design.md §5.7; docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md ownership
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Explicit launch/account/fork fixtures, literal statuses/bytes and fixed message identities; real oversized stream for cap enforcement.
- **Stable seam:** AgentChatService → real temporary host Unix socket, durable tab records and binary upload seam
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Owns the daemon service boundary between tabs, accounts and the separate host. Adapter tests never execute daemon selection/rollback; proxy tests stub the service. Removed final manually assembled fork integration was superseded by actual route + tool + service owners.
- **Production callers:** index.ts; proxy-routes.ts; mcp/daemon-api.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 436: the launch env is the registry entry's env UNDER the resolveExtraEnv contributors | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 467: an OpenCode thread carries its per-launcher env file and the PROJECT ROOT | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 483: a keyed OpenCode server named by the launch env reaches the host on create, fork and a fork's reconcile | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 500: trust is granted for the validated projectPath, NEVER the request's cwd | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 524: a projectPath outside the sandbox grants NO trust, and the launch still works | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 540: a Grok thread no longer touches any home config file | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 568: the tab record is written FIRST and rolled back when the host refuses | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 587: a host that stops answering a create reads as not responding, not as not running | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 606: a conversation already open elsewhere is refused with the owning tab's id | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 639: an agent row with no chat adapter cannot open a chat tab | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 653: a resume id the adapter cannot use is refused at creation, never degraded | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 676: §6.1's fields ride the nested `chat` block the client sends | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 704: a bad resume in the nested block is refused just as the flat one is | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 726: a workflow owner rides create → summary → sessions.json → re-adoption after a restart | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 757: the service refuses a malformed owner before the tab or the thread exists | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 803: a switch recomputes the launch env, calls the host, THEN moves the tab record | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 829: a switch carries the recomposed serverPool: the host replaces launch.json's with it | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 841: switching to System clears the account and never falls back to the family default | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 852: an account of another family is refused rather than silently degraded to System | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 865: an OpenCode thread cannot switch accounts | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 879: a host refusal leaves the tab record exactly as it was | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 893: an older host with no identity route reads as HOST_UNAVAILABLE, not a refusal | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 906: a switch on an unknown tab is THREAD_NOT_FOUND and a blank commandId is invalid | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 931: an install/update asks the host to re-probe the provider that entry maps to | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 941: a CLI version change asks the host to refresh its provider catalog | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 963: agent goals §5.7: a blocked deploy drain posts the goal hold, with authentication | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 972: agent goals §5.7, a host from before the hold: the snapshot read, the session stop and the hand-over reach the host as sent | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1029: agent profile §4.8: the OpenCode recycle reaches the host, and no answer makes it throw | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1095: a body that fails mid-upload fails the upload, never the daemon | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1117: an upload refused before it was sent leaves a failing body nothing to crash on | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1181: the upload route answers a cap refusal the host client wrapped 413 too, and any other host failure 503 | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1225: a host that refuses an upload before reading it is relayed as is, and the connection closes | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1243: an upload the host takes is relayed without closing the connection | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1260: a host refusal keeps the client connection open once all upload bytes are off the wire | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1313: a host that refuses while the upload is still arriving has the daemon's request to it torn down | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1338: a fully consumed upload preserves the host answer and all body bytes | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1369: an over-cap chat upload answers 413 UPLOAD_TOO_LARGE through the MCP seam too, and ends its owned stream | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1392: publishHtmlRender stores the prepared page through the host's upload and answers its reference | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1431: a fork opens in the parent's project under the parent's account, pinned | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1465: a system-identity parent's fork stays on the system identity | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1480: a fork refuses a parent whose account is gone, and rolls its tab back on a host refusal | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1556: a fork continued in another agent runs on that agent, account and model, with a transcript handoff | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1597: the same agent under another account continues by transcript; same agent and account stays an ordinary fork | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1616: a continuation is validated before anything is created | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1647: a host without cross-agent forks refuses a continuation, never forks it natively | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1660: a fork key aimed at another agent is another fork: COMMAND_ID_CONFLICT | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1672: a delegate or opened chat names a parent in any project; any other relation is refused | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1714: a fork's commandId makes it idempotent: a double submit, or a repeat after a restart, is one tab | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1734: a delegate's lineage records its delegation depth, a fork carries its parent's, and closing the middle keeps it | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1761: opened and delegate links: agentCreated is stamped as given, and only agent-made links deepen delegationDepth (§13 c) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1794: a fork records agentCreated only when the (gated) request carries it, and keeps it on a keyed repeat | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1808: workflowOwned is stamped at creation from a workflow-owned creator (or a marked one), through delegate, opened and fork, and survives the creator closing (§5.4) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1840: a delegate's project is compared resolved, and the child groups under the parent's spelling | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1859: a reused fork commandId with another fork point, or after its fork was closed, is COMMAND_ID_CONFLICT | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1880: a fork the host refused rolls its tab back without a host delete, so the same key forks again | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1895: a fork whose answer was lost keeps its tab, and the same key's retry converges on it | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1921: a 200 fork answer without the child's head is an unknown outcome, never a refusal | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1940: a fork tab whose answer was lost is confirmed once the host answers, its fork point set | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1959: a fork tab the host never created is taken back by the reconcile, and its key forks again | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1982: the reconcile never deletes a child the host did create, and leaves a fork in flight alone | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1996: a new chat is announced as pending until the host has its thread, then confirmed with an update | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 2014: a fork whose answer was lost stays pending, also across a restart, until the reconcile confirms it | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 2029: a plain create a daemon restart interrupted stays pending, then is confirmed or taken back (D-T2) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 2050: the reconcile re-sends the lost fork's whole request — cut and launch environment — with confirmOnly | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 2068: only the host's 'no such thread' takes a stray fork tab back; any other refusal keeps it for later | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 2095: a fork the host keeps refusing to confirm is asked with a doubling backoff, then taken back (D-T2) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 2123: a stopped service reconciles nothing | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 2136: after a restart, a keyed fork's recorded request tells a repeat from a reuse exactly | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 2185: publishHtmlRender measures the PREPARED page at every client width and publishes the heights | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 2209: publishHtmlRender publishes without heights when nothing could measure | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 2219: previewHtmlRender screenshots the bootstrapped page with the stock theme of the appearance asked | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 2237: previewHtmlRender without a page browser says so | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 2246: fork_session through the fork route's real principal gate and this service: a self-fork is agentCreated, a fork of another chat is not, workflow ownership is inherited (unified MCP Task 8) | DELETE | Fails stable seam and unique protection: a mock DaemonApi manually dispatches a fork and calls gateForkBody, so this is not actual route registration. Self/other-agent flags and inherited ownership already have separate actual route, public tool and service owners. Survives in lineage-routes.test.ts principal gates; mcp/tools/conversation.chat.test.ts self-fork; service.test.ts agentCreated and workflowOwned cases. |

### apps/daemon/src/agent-chat/session-index.test.ts

- **Independent contract/source:** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §5.2 migration; AGENTS.md durable session ownership and tolerant stores
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Literal legacy/chat/unknown records, true filesystem corruption/access failure, selected surviving IDs and bytes.
- **Stable seam:** Real SessionManager/LocalSessionManager reattach and serialized sessions.json
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Owns shared index persistence across chat and both PTY backends. Chat manager record roundtrips alone cannot detect PTY reaping or writes over unreadable files.
- **Production callers:** sessions.ts; index.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 90: reattach routes chat records to their contributor and never attaches a PTY to them | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 102: a chat record is never reaped as an orphan tmux session | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 132: §5.2 migration: a legacy `agent` record with a live pane stays a terminal, flagged | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 142: §5.2 migration: a legacy `agent` record with NO live pane is forgotten | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 150: one persisted index holds updated chat and terminal records | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 166: concurrent writes retain the latest complete session index | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 189: an unreadable sessions index fails reattach, so nothing takes a missing tab for a deleted thread (D-M2) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 205: the direct-PTY backend's reattach also fails on an unreadable index, and not on a missing one (D-M2) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 240: tmux: an unreadable index is never written over — the chat tabs in it survive the run | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 256: tmux: a corrupt index is moved aside, kept whole, before anything new is written | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 269: tmux: records and top-level keys this build cannot read are written back as found | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 285: direct PTY: the same — never written over when unreadable, unknown records kept | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 323: tmux: panes that survived a corrupt index are kept known, never reaped by a later boot, until they end | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |

### apps/daemon/src/agent-chat/summary.test.ts

- **Independent contract/source:** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §6.4; MCP-v2 attention cursor §9.2; docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md approval and worker privacy
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Literal summary/requests/time fixtures; exact state transitions and independent secret sentinel, not DOM copy.
- **Stable seam:** AgentChatSummaryService polling a real temporary host socket → tab fields, bus, push and callbacks
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Owns poll-to-tab/event/push translation and first-discovery/re-adoption behavior. Activity ladder tests do not poll, stamp or suppress repeated side effects.
- **Production callers:** service.ts; index.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 99: a daemon restart NEVER pushes for state it is merely discovering | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 129: a knowledge indexer's worker chat never pushes | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 152: a re-adopted thread (after forget) also seeds silently | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 163: a continuing goal never feeds the drain's background-work view (goals §4.7) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 175: an errored thread keeps status 'running' — the TAB is live — and shows the error via activity | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 191: needsAttentionAt is stamped when attention rises and cleared when it clears | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 225: approval A answered and approval B raised inside one poll restamps, and says so on the bus | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 250: a turn that starts and settles inside one poll restamps; a turn that stays settled does not | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 276: the same turn settling under a still-open question restamps too | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 308: a request that stays open keeps its stamp; only a request id the last poll lacked restamps | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 334: a restamp alone never pushes: pushes stay gated on the attention VALUE changing | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 368: a rewind back onto a turn that settled long ago keeps the stamp | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 391: a history replay committing settled rows one poll at a time keeps the stamp | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 416: two turns that fail before the provider names them, inside one poll, restamp | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 437: a turn moving into pending or running never restamps, whatever its completedAt says | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 468: a turn transition becomes the coarse agentChat.turn bus event | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 487: a settled turn reopens the version drain window | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 507: agentChat.pending fires once per open and once per close, deduped across polls | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 540: one request closing while another opens is TWO events, not silence | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 566: pending rows are validated and duplicate request IDs keep the last row | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 585: a thread the host no longer has closes out its open requests | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 598: a failed read leaves the last known state alone rather than blanking the tab | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 606: a summary body is validated field-wise before it reaches typed code | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 631: the daemon's own background-liveness view feeds the drain, and its ending reopens the window | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 653: hasPolled flips after the first completed poll round, even an empty one | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 662: the goal is validated field-wise, with a fallback, before the ladder reads it | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 688: a thread's live usage reading is handed on once per new reading, with the tab's entry | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 717: a pending request_secret card is a pending question: tab, attention, agentChat.pending, push (design 2026-10-14 §5) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 757: a pending Orquester approval card is pending user input: tab, attention, agentChat.pending, one titled push (unified MCP §7.5) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 796: without an approval push the card's needs-input transition pushes the structural one | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 807: an approval card on a knowledge indexer's worker chat pushes nothing (neither the card's push nor the structural one) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 835: an approval card pushes once for its life, even when its thread is forgotten and re-adopted | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 856: a thread's usage-limit notice is handed on when it moves, never for a host without the field | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |

### apps/daemon/src/agent-chat/supervisor.test.ts

- **Independent contract/source:** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §3.1 boot adoption/handover; docs/superpowers/specs/2026-09-24-agent-goals-design.md §5.7; documented pending-wake regression
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Queued health frames, virtual elapsed windows, literal spawn/kill/status/continuation effects and preserved token bytes.
- **Stable seam:** AgentHostSupervisor state machine against explicit process/tmux/probe boundaries
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Only owner of daemon adoption/drain/dead-host recovery decisions; host teardown tests do not decide when to signal or replace another process.
- **Production callers:** service.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 281: case 2: healthy + same protocol version adopts without spawning | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 291: case 3: a version mismatch adopts first, then restarts once drained | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 303: case 3: a moved CODE stamp is a drain-restart too, not only a protocol bump | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 321: the same code stamp, or an unknown one on either side, adopts without restarting | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 351: case 3: a version mismatch with an ACTIVE turn adopts and waits | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 361: a restart deferred for 6 h warns, then once per 6 h — never per tick | REWRITE | Remove exact operational warning copy assertion; independent six-hour warning cadence and no restart during active work remain. |
| 385: case 4: a token rejection from a process that is not ours is FOREIGN — never killed | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 396: a token rejection from OUR OWN service session is a stale token, not a stranger | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 410: case 5: nothing answers → spawn and poll READINESS | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 422: a host that never reaches readiness leaves the supervisor stopped, not healthy | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 430: a replacement that becomes ready after its deadline is adopted without another restart | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 460: health supervision respawns a dead host and latches error after the cap | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 478: a changed hostInstanceId is observable (a restart is not a reconnect) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 487: the host pid is in the kill guard's protected set | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 494: the no-tmux fallback spawns a direct child and protects its pid | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 502: a throwing tmux spawn NEVER rejects out of checkHealth (it would kill the daemon) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 548: a spawn that throws during boot adoption leaves the supervisor retryable | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 556: a leftover service session is killed before the respawn | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 569: the drain-restart re-probes: a stale 'no active turn' never kills a live turn | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 591: one missed probe does NOT kill a healthy-but-busy host | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 607: a busy host gets MORE patience before it is killed | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 624: a single answered probe clears the missed-probe streak | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 640: a silent host whose process is alive on a saturated box is starved, not dead — it is not restarted | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 658: a starved host is restarted anyway once its patience runs out | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 673: a saturated box does not shield a host whose process is gone | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 686: the old host is given a grace window to EXIT before its session is killed — a closed socket is not enough | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 711: the grace window is bounded — a host that never exits is killed anyway | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 724: case 3: live BACKGROUND work blocks the drain exactly like an active turn | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 755: an older host that omits the background field is still held by the daemon's own liveness view | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 779: an older host is held while the daemon's view is still UNKNOWN — boot adoption runs before the first poll | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 796: a host that reports the background field itself is never held by an unknown daemon view | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 807: a host with only background work gets the same extra patience as a busy one | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 833: agent goals §5.7: every blocked drain evaluation asks the host to hold its continuing goals | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 864: agent goals §5.7: no hold is asked for without a deploy waiting, or on a drained host | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 883: agent goals §5.7: a manual restart never asks for a hold, even with a deploy's restart pending | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 897: agent goals §5.7: a failing hold request never stops the drain, and never prevents a later restart | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 928: agent goals §5.7: a host that predates the route is not asked again, but another instance is | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 950: agent goals §5.7: boot adoption never waits for the hold — the daemon listens while the host answers | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 973: agent goals §5.7: a restart may overtake a hold in flight, and stays healthy after its late answer | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1042: agent goals §5.7, an older host: a Codex goal loop is stopped at its turn boundary, and the next host resumes its session | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1075: agent goals §5.7, an older host: two goal loops are each stopped at their OWN boundary | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1092: agent goals §5.7, an older host: anything else in the way stops nothing, and the deploy waits as before | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1141: agent goals §5.7, an older host: a stop that fails is tried again and handed over all the same; a hand-over the new host cannot take is asked again | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1172: agent goals §5.7, an older host: a stop whose reply is lost may still have landed — its thread is handed over | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1185: legacyGoalTurnOf: a Codex turn with no user message behind it, started as the one before ended, is a goal loop | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1259: the token is regenerated AFTER the old session is killed, never before | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1274: a moved providersRevision raises agent.providers.changed | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1289: an older host with no providersRevision never raises the event | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1298: hostSupports reads the ADOPTED host's capabilities: an older host has none (Agent Profiles) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1311: agentHostSupports tolerates every shape an older or odd host answers | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1323: the launch environment is built explicitly, never from process.env | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1366: pending wake: the bbd7145a timeline — the end defers the drain, the wake turn runs, its settle hands over | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1411: pending wake: one the provider never acts on holds the drain only for the cap | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1429: pending wake: the cap is configurable | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1444: pending wake: a host from before the field gets a grace after background work ends — a settled turn of that thread ends it | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 1465: restart status: every blocker per thread — a turn, a shell with its command and age, a subagent | REWRITE | Remove arbitrary shortened-commit wording assertion; exact original host/checkout stamps and typed per-thread blocker payload remain independently asserted. |

### apps/daemon/src/agent-chat/tool-approvals.test.ts

- **Independent contract/source:** docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md §7, §13 approval/security/persistence rules
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Explicit secrets/principals/competing decisions, literal event/outcome/error codes and actual journal bytes; controlled deadline.
- **Stable seam:** ToolApprovalRegistry plus real Fastify list/detail/answer routes
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Owns approval lifecycle, retained secret exclusion, journal recovery and person-only route decisions. Executor/port tests cannot exhaust registry races or byte limits.
- **Production callers:** agent-tools/approval-port.ts; agent-tools/routes.ts; index.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 89: approve: the waiting call gets the outcome; opened/closed events, attention changes and one log line | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 111: deny: the user's reason reaches the call, sanitised; a grant on a deny is refused | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 121: timeout: the deadline (injected clock) ends the wait as timed_out; a late answer is 409 | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 133: cancel: the call's signal (abort, Stop, session end) ends the wait as cancelled | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 148: a closed chat cancels its cards; shutdown cancels every card | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 164: two clients: the first answer wins, the second is 409; unknown cards are 404; another thread's card is 404 | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 181: a grant outside grantOptions is 400 and the card stays pending; an offered grant is accepted | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 200: a refused preparation keeps the card pending; the deadline winning during preparation makes the answer 409 | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 218: card secrets go to the waiting call only: never in events, summaries, details, logs or the journal | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 238: agent-derived text is sanitised: bidi/control/zero-width stripped from labels, escaped in code | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 259: long previews: the summary is cut to 64 KiB and marked fullPreview; the detail has it all; over 1 MiB is PREVIEW_TOO_LARGE | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 279: an approved call whose result never reached the host closes again as not_delivered | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 292: a daemon that died with cards open resolves them as cancelled at the next boot — never approved | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 338: routes: list, detail, answer; only a person answers (agent and external principals 403); unknown chat 404 | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 377: at most MAX_PENDING_TOOL_APPROVALS_PER_THREAD cards wait per chat (APPROVAL_LIMIT); other chats are not affected | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 391: a read-only store refusing the approval's write answers 503 AGENT_TOOLS_UNAVAILABLE and keeps the card | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |

### apps/daemon/src/agent-chat/visual-urls.test.ts

- **Independent contract/source:** docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md §2.2 signed URLs; packages/api/src/agent-chat/wire.ts public /api/agent-visuals route
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Literal public path prefix and ≤15-minute security ceiling; valid-at-advertised-expiry / invalid-after and chosen tampering cases.
- **Stable seam:** createVisualUrlSigner.mint/verify with production random key and controlled Date
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Lowest owner of cryptographic binding, expiry and daemon-key isolation. Proxy tests cover attachment serving/CSP but cannot detect each signed component or future expiry.
- **Production callers:** service.ts; proxy-routes.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 22: a minted URL is the visual route with exp and sig, valid for 15 minutes | REWRITE | Use literal public route and ≤15-minute ceiling, then valid-at-advertised-expiry / rejected-after through public methods. Merge expired case; remove key/time injection. |
| 34: an expired URL is refused | CONSOLIDATE | Duplicate signer setup for expiry is merged into the minted URL lifecycle. Validity at advertised expiry and rejection one millisecond later are both asserted by the owner. Survives in visual-urls.test.ts minted URL lifecycle. |
| 40: a tampered URL is refused: session, page, expiry and signature are all bound | REWRITE | Use production-created random keys rather than injected known keys; retain every signed component and independent-daemon rejection. |
| 54: a signature claiming more life than a minted URL has is refused | REWRITE | Drive real public signer with built-in controlled Date instead of optional nowMs test seam; future-valid signature remains refused now. |

### apps/daemon/src/agent-chat/waits.test.ts

- **Independent contract/source:** docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md §8.6 cycle/refcount rules
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Explicit a→b→c graph, WAIT_CYCLE code and observed release/refcount behavior.
- **Stable seam:** asWaiter/registerWait/waitsOn: public wait graph lifecycle
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Lowest owner of cross-tool wait cycle detection and concurrent refcounts. Tool tests exercise only their own registrations and cannot protect the shared graph.
- **Production callers:** replies.ts; mcp/tools/watch.ts; mcp/tools/messages.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 15: refuses a direct and an indirect cycle at once, and forgets a wait once it ends | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 31: counts two waits on one target: the first ending keeps the second registered | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |

### apps/daemon/src/agent-tools/approval-port.test.ts

- **Independent contract/source:** docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md §3.3, §7, §9.3 grant/approval policy
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Literal grant/card outcomes with explicit changing permission modes, paths and ownership; real symlink fixture.
- **Stable seam:** AgentToolsApprovalPort with real registry/store and daemon caller-trait lookup
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Lowest owner of offered grants and post-answer checks. Executor wiring tests do not exhaust all grant-forbidden scopes, workspace targets or canonical project matching.
- **Production callers:** index.ts; mcp/executor.ts; agent-tools/routes.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 113: approve with a grant: the grant is recorded (by commitGrant, after the call's re-gate) and honoured for the next call while the caller is full-access | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 140: commitGrant re-checks Full access: a chat that left it after answering gets no grant | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 156: the card's pending temp projects and a workflow-referenced prompt are never grantable, whatever its options say | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 170: workspace-level targets on the card: the port itself offers no grant, whatever the card's options say | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 183: grants are never offered to a caller below full-access, nor for cross-project Admin, whatever the card says | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 211: a caller that left full-access while the card was open cannot attach a grant (approve without one still works) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 223: workflow-owned callers never get a card: Admin → ADMIN_NOT_AVAILABLE, boundary → PERMISSION_DENIED | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 239: a spend card (create_box) opens for a workflow-owned chat, offers no grant, and expires as timed_out | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 254: an older build's toolset card is never opened: every tool is on already | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 261: workflows grants (ruling): a create joins the chat's grant and the card says so; approving a run once never widens it | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 324: a read-only store: a grant answers 503 AGENT_TOOLS_UNAVAILABLE; approving without a grant works | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 335: cancellation reaches the card: the call's signal and the 30-min deadline | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 348: traits from the daemon: tab presence, workflow ownership along lineage, the thread head's mode (unknown on a failed read) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 381: threadInfo reports the CANONICAL project path, so a symlinked project's grants match the executor's | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |

### apps/daemon/src/agent-tools/executor-port.test.ts

- **Independent contract/source:** docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md §3.3/§7/§9.3 production executor-port integration
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Chosen card decisions and caller-mode transitions, literal execution/refusal/grant references and persisted grant state.
- **Stable seam:** connectExecutor/createAgentToolsRuntime → real executeToolCall, registry and grant store
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Owns actual global port wiring, post-card gate and disconnect ownership. Isolated executor doubles or isolated port calls cannot catch a disconnected/miswired production port.
- **Production callers:** index.ts; mcp/executor.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 146: an Admin call opens a card through the real port; approved, it runs with the card's approval | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 164: denied, the call is refused with the user's words and never runs | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 176: approved with a chat grant: the next call is covered by the grant without a card, until it is revoked | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 203: a grant chosen on a card is recorded only once the call passed the post-card re-gate: refused there, no grant and no sub-workflow joins | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 233: workflows: a create approved with a chat grant joins its new id to that grant (only the outcome's grantId); approve-once joins nothing | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 257: every tool runs from any chat with nothing configured: no TOOL_NOT_ENABLED, whatever its group | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 265: shutdown: disconnected first — no card, no grant (non-Admin tools still run); a late card is cancelled | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 292: a disconnect clears only the ports that are still its own | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |

### apps/daemon/src/agent-tools/routes.test.ts

- **Independent contract/source:** docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md authentication, person-only settings, grants and approval secrecy
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Real auth-session bearer, literal HTTP codes, explicit secrets, revoked grants and event/log inspection.
- **Stable seam:** Actual createServer registration in local/remote modes plus direct route principal gate
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Owns both transport mounting/auth and HTTP mutation secrecy. Registry routes in isolation cannot detect accidental remote exposure or missing auth mounting.
- **Production callers:** index.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 79: remote HTTP: every route is behind the bearer; with it they answer | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 99: both transports: a card answered over the socket or HTTP; secrets never in a response, event or log; revocation over HTTP | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 157: agent principals are refused on every write and on card answers (403); reads stay open | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |

### apps/daemon/src/agent-tools/service.test.ts

- **Independent contract/source:** docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md §9.6/§7.6; AGENTS.md tolerant stores/secret permissions
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Literal old/new/unknown records, filesystem failures, selected principals/paths and independent timestamp fixtures.
- **Stable seam:** AgentToolsService → real temporary agent-tools.json and grant queries
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Owns durable grant writes, compatibility, fail-closed read-only operation and long-missing project pruning. Config parser tests do not write/serialize concurrently or recover corrupt files.
- **Production callers:** agent-tools/approval-port.ts; agent-tools/routes.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 55: a missing file is the defaults (nothing written); the settings view is the grants alone | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 62: an older build's file: its toolset switches are never read and survive every rewrite untouched; grants work beside them | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 94: a corrupt file is moved aside: defaults apply and no grant is honoured (fail closed) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 110: an unreadable file makes the store read-only: no grants, every mutation 503, nothing written over it | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 123: grants: full-access only; lastUsedAt stamped; revocation effective for the next call; workflows ids appended | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 156: a closed chat's chat grants and legacy rows are deleted; project grants and other chats' rows stay | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 179: a missing project's grants are pruned only after repeated misses over time, never by a read | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 204: writes are serialized: the last write carries the last state | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |

### apps/daemon/src/session-tools/deny-e2e.test.ts

- **Independent contract/source:** docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md §12.1; session-tools/README.md provider config detection and containment
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Independent provider-native configuration files containing a secret sentinel; literal denied names and no-secret manifest results.
- **Stable seam:** Real DaemonMcpDetector + actual route + SessionToolsRefresher reading temporary provider configs
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Critical cross-owner security workflow: actual config readers must find daemon credentials and feed the correct chat denials across every provider/home/realpath. Unit mocks do not prove that chain.
- **Production callers:** index.ts; agent-profile/daemon-mcp.ts; session-tools-refresh.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 32: a user MCP server carrying this daemon's bearer is denied in the chat manifest of every provider (Grok: also the Claude servers it inherits, in an account home) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 122: Codex: a project-level server is denied in every home, trusted or not; trust is display only | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 188: a chat whose cwd resolves outside its project, or whose project's real path is outside the workspaces root, denies every server known — and what its real location configures | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |

### apps/daemon/src/session-tools/instructions.test.ts

- **Independent contract/source:** docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md §9.5/D-13; Knowledge Graph design agent-tool instruction budget
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Literal 2048/256/2304 ceilings, chosen collection names and independently counted omitted collections.
- **Stable seam:** composeOrquesterInstructions → actual UTF-8 bytes delivered to agents
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Lowest owner of generated instruction byte budget and collection-name sanitization. Manifest tests only check selection/content presence and do not establish worst-case multibyte limits.
- **Production callers:** manifest.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 13: the worst case — workflow-owned — stays under 2 048 bytes | REWRITE | Remove declaration-only cap-function assertion; retain direct bytes of the actual composed output under independent 2048-byte budget. |
| 19: knowledge line: names only, last; absent for no collection — a chat without knowledge pays nothing | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 32: knowledge line: capped at 256 bytes — names that do not fit become '… (+N more)' | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 48: the worst case with the knowledge line — workflow-owned, many collections — stays under 2 048 + 256 bytes | REWRITE | Remove unused cap-function declaration assertion; direct worst-case multibyte/ASCII output remains checked against 2304 bytes. |

### apps/daemon/src/session-tools/legacy-aliases.test.ts

- **Independent contract/source:** docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md §14.1 and session-tools/README.md retained legacy-host removal criterion
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Frozen legacy protocol names and independently written mapped request expectations, reply semantics and refusal codes.
- **Stable seam:** chatToolByName + real executor accepting old wire arguments
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Only owner of old-host aliases and old reply semantics. Current catalog tool tests call current names and cannot detect alias migration failures. Removed exact old/new intersection inventory was not a compatibility requirement.
- **Production callers:** session-tools/route.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 65: an old host on this daemon: every name of the old server (the frozen definitions) is the catalog's own tool or an alias | REWRITE | Remove internal exact intersection inventory; retain every frozen old protocol name resolving through the actual alias/catalog boundary. |
| 72: thread_send without wait steers as before (reply none); with wait it waits WITHOUT the notify conversion | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 80: thread_create and delegate_task open a chat that delivers nothing (reply none); a delegate is marked | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 87: task_* and the thread reads map onto get_session / wait_for_session / control_session / read_transcript | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 107: the old argument names are the only ones taken; the target's own schema refuses a bad mapped value, naming the legacy tool | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 117: a name the catalog still serves is its own tool; an alias without its target is no alias | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |

### apps/daemon/src/session-tools/manifest.test.ts

- **Independent contract/source:** docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md §9.4/§12.1; Knowledge Graph plugin audience/worker contract
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Chosen catalog entries/tier policy and literal independently specified audience/deny-name sets.
- **Stable seam:** buildSessionToolsManifest/denyFor → tools, instructions and provider/home/project denials
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Lowest owner of manifest policy selection, including workflow/worker and inherited home scopes. Refresher wiring tests do not exhaust these cross-products; end-to-end detector tests cover config discovery instead.
- **Production callers:** session-tools-refresh.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 60: deny: the thread's agent, in its own account home or its project — exactly what its CLI loads | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 78: deny: a chat in a directory inside its project — the configs from the root down to its cwd, never a sibling's or a deeper one's | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 93: deny: a Codex project server in every home — trust (`loadedByHomes`) is display only | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 100: deny: a chat whose cwd or project leaves its bounds — every server of its agent known anywhere | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 110: deny: a server every home of the agent loads (Grok's inherited ~/.claude.json, allHomes) is denied in an account home too | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 118: the manifest: tools, the composed block and the deny list; no legacy toolsets field | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 139: knowledge gating matrix: plugin off/on × Global / profile with collections / profile without × worker / not | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 190: knowledge: a workflow-owned chat keeps the knowledge tools (none is Admin) and gets both lines, under the raised cap | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |

### apps/daemon/src/session-tools/route.test.ts

- **Independent contract/source:** docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md per-thread transport; docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md §5; session-tools/README.md caller identity/cancellation
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Literal outcomes and unforgeable thread/account/scope fixtures; real cancellation and chosen secret sentinel.
- **Stable seam:** Real Unix-socket session-tool route + real host forwarder/executor
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Owns authenticated host-to-daemon call transport and derived caller identity. Public MCP executor tests start after this route has built that identity.
- **Production callers:** index.ts; agent-host/session-tools/manifest-client.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 127: a call runs with the context the daemon derived — thread record, not arguments | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 155: results: image content, a coded handler error, an unknown tool | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 170: a Knowledge Graph worker chat may call its two worker tools and no other tool | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 187: only the host's bearer is honoured, and only for a thread the daemon knows | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 206: a daemon that cannot serve yet, or is not there at all, answers the restart message | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 218: a daemon that dies mid-call answers the restart message | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 230: cancelling the call on the host aborts the daemon-side handler | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 243: request_secret over the socket: the answer reaches the call; the host's cancel closes the card | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 280: the caller is built from the thread's tab and snapshot: title, mode, planning, exchange, workflow-owned; a tool of any group runs | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 352: a session-tool call builds its caller from the thread's HEAD, never its snapshot | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |

### apps/daemon/src/session-tools/session-tools-refresh.test.ts

- **Independent contract/source:** docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md §9.4/§12.1; session-tools/README.md manifests/denials/push/restart ordering
- **Real regression:** The individual scenario names the caller-visible failure; asserted returned state, wire bytes, persisted data or side effects must change for that failure.
- **Independent oracle:** Explicit server lists, API failures, withheld responses and literal manifest/refusal/push results.
- **Stable seam:** SessionToolsRefresher + real registered Fastify manifest route + DaemonApi scope boundary
- **Refactor resistance:** Assertions concern these outputs and lifecycle boundaries, not source text, import counts or private member names. Internal algorithms and helper names may change.
- **Unique protection:** Owns cached detection failure behavior, per-cwd reads, bounded dependencies, failed-launch pushes and daemon epoch/sequence behavior. Pure manifest tests cannot detect these asynchronous state transitions. Deleted exact LRU capacity and rewritten exact worker-pool size were internal policies, not caller contracts.
- **Production callers:** index.ts; agent-host/session-tools/manifest-client.ts

| Baseline line / test | Outcome | Reason / surviving owner |
|---|---|---|
| 78: the manifest: every chat tool, for any agent with nothing configured; its block and denials; no Admin tool for a workflow-owned chat | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 99: the daemon-pointing read: none from a daemon without it, reused while fresh, read again once invalidated | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 113: fail closed after an invalidation too: a failed re-read answers the last GOOD list, never [] | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 124: only a route-miss 404 means "no detection"; a 404 with our own code is a failure | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 133: Task 11's own refusals (its {error: {code}} envelope: a 404, a 400 for a projectPath outside the workspaces root) are failed reads: the last good list, else unavailable (503) | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 153: fail closed: with no good read ever, a failed read makes the manifest unavailable (503), every failure warned | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 172: the manifest route: socket-only bearer, 404 for no chat, every chat tool for a launch or a look | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 192: a push hands the host the chat's manifest and answers what the host did with it | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 209: a refresh of every open chat (the boot refresh) pushes each one, at most REFRESH_CONCURRENCY at a time | REWRITE | Replace production-derived exact worker-count oracle and gates with every open chat pushed exactly once and each returned answer. Any behavior-preserving worker-pool rewrite now passes. |
| 241: manifests carry this daemon's epoch beside the sequence | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 251: the daemon-pointing read is bounded: no answer in time, nothing ever read → unavailable | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 269: concurrent manifests share ONE daemon-pointing read | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 291: the session list read inside a manifest is bounded: no answer in time counts as workflow-owned | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 300: a chat refused for unknown denials gets its manifest pushed once the daemon-pointing read lands | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 325: a chat started in a directory inside its project is denied the servers configured on the way down to it | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 353: a refused chat stays remembered until a push actually reached the host | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 388: per-cwd reads are cached for at most MAX_POINTING_SCOPES scopes (the all-projects read always stays) | DELETE | Fails independent contract, independent oracle and refactor resistance: expected eviction capacity is read from the same private MAX_POINTING_SCOPES constant. Public fresh-cache/invalidation/fail-closed behavior remains covered by the retained detection-read tests. |
| 402: Knowledge Graph: the chat's knowledge view is read fresh for every manifest; failing or unanswered it counts as off | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
| 439: Knowledge Graph: a worker session (its owner in the session list) gets ONLY the worker tools even when the knowledge read fails, hangs or is unwired | KEEP | Named outcome is the independent regression witness at this file’s seam; all six evidence criteria above apply. |
