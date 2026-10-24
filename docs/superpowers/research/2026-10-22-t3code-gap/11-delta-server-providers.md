# T3 delta (ed9b7ca9..66ee628e): server, agent runtime, providers, orchestration, automation

Analyst 11 of the delta round. It covers T3's new commits from `ed9b7ca9` to `66ee628e` (111 commits, including v0.1.2) that touch the server, the agent runtime, providers, orchestration and automation. It also covers five server PRs listed in the v0.1.2 notes that sit just before `ed9b7ca9` and that no earlier report covered: #22581, #22653, #22709, #22713 and #22732. #22732 (`t3 thread`) is already in `08-cli-ops-automation.md` and is not repeated here.

Path prefixes:
- **T3/** is `t3code_codebase/`.
- **ORQ/** is this worktree (`t3gap/integration`).
- **host/** is `ORQ/apps/daemon/src/agent-host/`.

This is a read-only analysis. No tests or builds were run. Where a claim depends on how a provider CLI behaves at runtime and could not be checked by reading code, it is marked **unverified**.

## 1. Table

Same bug? means: does Orquester have the defect T3 just fixed, or a close analogue of it? Value and effort are H/M/L and S/M/L.

### Stop, delegates and subagents

| Change | T3 evidence | Orquester status (with paths) | Same bug in Orquester? | Value | Effort |
|---|---|---|---|---|---|
| **Stop stops a thread's subagents again** (`fbc6a081`, #23886). A Stop that changed nothing on the parent, because the parent was idle, no longer queued `delegated-tasks.stop`, so app-owned children kept running. | T3/apps/server/src/orchestration-v2/Orchestrator.ts (`delegatedTasksStopEffect`, queued on both Stop paths), EventSink.ts (a Stop with effects but no events still commits), packages/contracts/src/orchestrationV2.ts (`stopDelegatedTasks`) | **Have it.** The cascade starts on every Stop the host accepts, whether or not a turn is running: ORQ/apps/daemon/src/agent-chat/proxy-routes.ts:249-256 → `DelegateStopCascade.commandAccepted` (ORQ/apps/daemon/src/agent-chat/delegates.ts:124). The host accepts an idle interrupt and writes an activity instead of returning an error (host/orchestration/orchestrator.ts:3016-3027). An idle Claude Stop also closes the CLI's background work (host/adapters/claude/session.ts:2176-2183). | **Not that bug, but a worse one next to it** (finding F1): the cascaded children's "interrupted" reply notices wake the parent the user just stopped. | H | S-M |
| **Stop on a delegate always clears it, even when stuck** (`6a6c84f9`, #22653). A user Stop on an app-owned task marks it cancelled with `completionDelivery: disposed`, so its result is never delivered to the parent agent. | T3/apps/server/src/orchestration-v2/Orchestrator.ts (`cancelledAppOwnedTask`, `writeAppOwnedTask`), T3/apps/server/src/mcp/OrchestratorMcpService.ts | **Different model.** Orquester keeps no parent-side task record that can get stuck. A delegate is its own chat, and the parent waits on a persisted reply subscription (ORQ/apps/daemon/src/agent-chat/replies.ts:1-43). If the delegate's turn is interrupted, the router still delivers an "interrupted" notice to the parent (replies.ts:1767-1769; text in ORQ/packages/api/src/agent-chat/thread-tools.ts:305-306). | **Partly.** Nothing gets stuck. But Orquester delivers where T3 now disposes, which is what causes F1. | (in F1) | (in F1) |
| **Idle orphaned follow-ups can be cancelled without a running parent** (`849b3f89`, #22581) | T3/apps/server/src/orchestration-v2/Orchestrator.ts (`cancelIdleOrphans`), OrchestratorMcpService.ts | **N/A by design.** There is no follow-up task on the parent. Subscriptions end through notices ("closed", "failed", "interrupted") or through Discard and Deliver now on the delivery queue (ORQ/apps/daemon/src/agent-chat/lineage.ts:1-33). | No | L | – |
| **Delegates finish when their leftover work settles; Grok commands stop holding runs open** (`163bdeaa`, #22709) | T3/apps/server/src/orchestration-v2/Orchestrator.ts (`settlesChildWork` stream), T3/packages/provider-grok/src/server/xaiAcpExtension.ts (`KillTask` outcome, structured task ids) | **Partial.** A delegate's result is the bound turn's final reply (replies.ts:8-13), delivered as soon as that turn settles. Background work the child left running (a Claude background shell or agent, or a Grok command) is not waited for. A later provider-initiated turn that reports the result is never delivered, because the subscription is bound to the first turn. The Grok `KillTask` and `TaskOutput` parsing is already handled (host/adapters/grok/background-tasks.ts:715-735, 792-830). | **Analogue (F8).** The parent gets "started X in the background" and never hears the outcome. | M | M |
| **Resume Codex parents after native children finish** (`11adcb0e`, #23840). Codex does not wake a parent whose turn already completed, so the child's result sits unread until the next user message. | T3/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts (`continuationRequests.offer`, `codexNativeSubagentDetail`) | **Missing.** Collab children are routed and shown (host/adapters/codex/child-routing.ts), and the code knows that "a child works on past the parent's turn" (host/adapters/codex/session.ts:433). Nothing wakes the parent: there are no wake or continuation hits in host/adapters/codex or host/orchestration. | **Yes (F7)** | M | M |
| **Stop abandoned turns before continuing threads** (`6f6f68ad`, #23169). A run marked failed while its provider turn still ran was reused, which left two turns live. | T3/apps/server/src/orchestration-v2/ProviderTurnStartService.ts (`abandonedTurns`, `interruptTurn` with `requestRuntimeRestart`) | **Have it.** A session the thread reads as `error` (for example after the watchdog's settle, host/orchestration/orchestrator.ts:2544-2570) is never reused. The next message first stops the live provider session (orchestrator.ts:1795-1809). | No | – | – |
| **Claude approval feedback routed to the requesting agent** (`b7e802bd`, #23657). For a Claude approval, the text sent over the card becomes the deny `message`, so it reaches the agent that asked, including a subagent. No separate user turn is sent. | T3/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts (`permissionResultFromDecision` `feedback`, `supportsFeedback`), T3/apps/web/src/components/chat/useComposerSend.ts | **Partial.** The recently ported redirect denies with a fixed `APPROVAL_REDIRECT_MESSAGE` and then steers the user's text into the main agent (host/adapters/claude/decisions.ts:72-81, host/adapter.ts:331-337, ORQ/packages/api/src/agent-chat/wire.ts:696-709). | **Yes, for subagent approvals (F4)** | M | S |

### Process lifetime

| Change | T3 evidence | Orquester status (with paths) | Same bug in Orquester? | Value | Effort |
|---|---|---|---|---|---|
| **A Claude agent stops when the server that started it dies** (`5ffe0459`, #23389). The CLI finishes its turn after its pipes close, so a crashed server left it working next to the session the restarted server resumed. The fix is a fd-3 lifeline watcher in the CLI's process group that runs `kill -TERM 0` at EOF. | T3/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts (`CLAUDE_GROUP_WATCH_SCRIPT`, `spawnClaudeProcessGroup`) | **Missing.** Nothing ties a provider CLI's life to the agent host:<br>• Claude is spawned by the SDK itself in the host's process group (no `spawnClaudeCodeProcess` outside boxes, host/adapters/claude/session.ts:516).<br>• Codex, Grok and OpenCode use `spawnProviderChild` with `detached: true`, a new session (host/support/spawn.ts:113-127).<br>• The host has no crash handler for children (host/main.ts:1116-1117 handles only SIGINT and SIGTERM).<br>• The only boot-time cleanup closes log rows, not processes (host/orchestration/leftover-work.ts). | **Likely yes, and newly sharper (F2).** The just-ported crash-safe resume (host/README.md "Boot order" step 2) resumes exactly these orphaned turns. | H | M |
| **agent-browser and Chrome no longer outlive the agent that started them** (`1aa71796`, #21299). When the agent exits, its systemd scope is stopped, which reaps daemons a tool `setsid`'d away. | T3/apps/server/src/process/agentScope.ts (`stop`), T3/packages/provider-acp/src/server/AcpSessionRuntime.ts, ClaudeAdapterV2.ts (`onExit` → `agentScope.stop`) | **Partial.**<br>• Only Grok sweeps a launch's leftovers, by the `ORQUESTER_AGENT_LAUNCH` marker in recorded sessions (host/support/leftover-processes.ts, host/adapters/grok/session.ts:2074, 2166; host/adapters/grok/index.ts:759).<br>• Claude, Codex and OpenCode get nothing after exit. The `spawn.ts` group kill reaches only the group (`process.kill(-pid)`, spawn.ts:163-178), it is skipped when the child already exited (spawn.ts:181-183), and a `setsid`'d daemon is in another group anyway.<br>• Orphans are listed, and stoppable by hand, in Settings → System (ORQ/apps/daemon/src/system-status.ts:264-282, 1440-1493). | **Yes for Claude, Codex and OpenCode (F3)** | M | M |

### Persistence and stream performance

| Change | T3 evidence | Orquester status (with paths) | Same bug in Orquester? | Value | Effort |
|---|---|---|---|---|---|
| **Route SQLite reads around writer contention** (`6ed47b53`, #23902) | T3/packages/shared/src/nodeSqliteClient.ts, T3/apps/server/src/orchestration-v2/ProjectionStore.ts | **N/A.** The only SQLite is the disposable thread index: one synchronous connection, WAL, chunked catch-up with yields, and `coverage()` answers "catching-up" instead of waiting (host/index/sqlite.ts, host/index/index.ts). | No | L | – |
| **Speed up shell snapshots on large databases** (`c7e3993f`, #23751) | ProjectionStore.ts (one grouped count), Migrations/068 | **N/A.** There is no all-threads projection query. Summaries come from the in-memory fold or `state.json` (ORQ/apps/daemon/src/agent-chat/summary.ts, host/server/http-server.ts). | No | L | – |
| **Avoid a full shell read on resume** (`d7a8d6f3`, #23987) | T3/apps/server/src/ws.ts (`listActiveSubagentThreadIds`) | **Same kind of cost elsewhere.** A reconnect's `GET /threads/:id/events?after=N` goes through `measureReplay` (host/orchestration/orchestrator.ts:5878-5925) → `store.readTail`, which reads and JSON-decodes the **whole** `events.ndjson` and then filters it (host/store/index.ts:1162-1170, 612-647). This happens even when `after` equals the head. A positional reader exists (`readEventsFrom`, host/README.md "store") but this path doesn't use it. | **Yes, performance (F5)** | M | S |
| **Keep subagent transcript updates off the shell stream** (`fd1063ba`, #23783) | T3/apps/server/src/orchestration-v2/ShellStream.ts | **N/A.** The daemon bus carries coarse transitions only. Subagent rows ride the parent thread's own stream. | No | L | – |

### Providers and auth

| Change | T3 evidence | Orquester status (with paths) | Same bug in Orquester? | Value | Effort |
|---|---|---|---|---|---|
| **Managed Codex token renewal kept in the server; active turns renew through native auth** (`478fdfc0`, `f5cf9a02`) | T3/apps/server/src/provider/CodexManagedTokenBroker.ts, T3/apps/server/src/cli/managedChatGptToken.ts | **Have it.**<br>• On the host, the Codex CLI owns `auth.json`, and the daemon refresher skips accounts a live session uses (ORQ/apps/daemon/src/agent-account-refresh.ts:28).<br>• In a box, mid-turn renewal goes through `account/chatgptAuthTokens/refresh` served by the box broker (host/adapters/codex/session.ts:2436-2442, ORQ/apps/daemon/src/boxes/broker/broker.ts). | No (an edge case, a profile change under a live session, is unverified) | L | S |
| **OpenCode retries failed model catalogs until they recover** (`807319c2`, #23939) | T3/packages/provider-core/src/server/managedProvider.ts (`refreshOnInterval` predicate), T3/packages/provider-opencode/src/server/driver.ts | **Partial.**<br>• The registry re-probes every 5 min, but only while a client watches (host/orchestration/provider-snapshots.ts:623-645).<br>• The adapter caches an **error** snapshot for the full 5-min TTL (host/adapters/opencode/index.ts:116, 562-565, 599, 656), so Settings → Refresh returns the same failure.<br>• The version probe already avoids caching a failure (index.ts:581-584). | **Yes, partly (F11)** | L-M | S |
| **Cursor fails turns that end in a transport error after commentary** (`656f3f40`, #23273) | T3/packages/provider-cursor/src/server/adapter.ts, transportFailure.ts | **No Cursor.** Analogue checked:<br>• Claude, Codex and OpenCode settle a mid-turn exit as `interrupted` or `failed`.<br>• **Grok** settles a non-host exit with code 0 mid-turn as `completed`: `exitOutcome` gives `stopped` (host/support/spawn.ts:223-225), then `turnCompleted({stopReason:null})` (host/adapters/grok/session.ts:2118-2129), then `"completed"` (host/adapters/grok/normalize.ts:1261-1275). | **Analogue in Grok (F12).** How often the CLI exits 0 mid-prompt is unverified. | L-M | S |
| **Pi: blank input placeholders no longer fail the run; fork completed turns while the next runs** (`6d9ec7bd`, `aa0158d0`) | T3/packages/provider-pi/src/server/adapter.ts | **No Pi.**<br>• Empty text is never sent: input is trimmed (host/orchestration/validate.ts:124-136), and each adapter skips empty blocks.<br>• Fork cuts before a running turn (host/orchestration/fork.ts:71-85). | No | L | – |
| **Abort interrupted ACP MCP fetches** (`e64a6d4c`, #23955) | T3/apps/server/src/mcp/AcpMcpStdioBridge.ts (`signal` on `fetch`) | **Have it.**<br>• The session-tools endpoint aborts on `notifications/cancelled` or a closed connection (host/session-tools/endpoint.ts:145-167), and the forwarder drops the socket (host/session-tools/forwarder.ts).<br>• MCP-App capture is bounded at 15 s and aborts on close, but not on an interrupt alone (host/adapters/mcp-app-capture.ts:80-118). | No | L | – |
| **Probe the Windows startup env asynchronously** (`f460ddb2`) | T3/packages/shared/src/shell.ts | **N/A.** There is no synchronous login-shell probe at startup. The only sync call is `tmux -V` (ORQ/apps/daemon/src/tmux.ts:104). | No | L | – |
| **Preserve typed requirements as the RPC group grows** (`cf3acd90`) | T3/apps/server/src/ws.ts | **N/A.** Orquester doesn't use Effect RPC. | No | – | – |

### Usage and limits

| Change | T3 evidence | Orquester status (with paths) | Same bug in Orquester? | Value | Effort |
|---|---|---|---|---|---|
| **Restore Claude subscription usage through proxies** (`7e52513a`, #12069). Adds a `User-Agent: claude-code/…` header for CLIProxyAPI. | T3/apps/server/src/usage/cliproxyApi.ts | **N/A.** There is no proxy integration. The direct fetch already sends that User-Agent (ORQ/apps/daemon/src/usage-sources.ts:186-187). | No | L | – |
| **Preserve Codex sign-in guidance in usage notices** (`53245cce`) | T3/apps/server/src/provider/CodexProvider.ts | **Different design.** Sign-in guidance comes from the probe and the auth overlay (host/adapters/codex/probe.ts:140-147, ORQ/apps/daemon/src/agent-chat/provider-auth-overlay.ts), not from usage rows. | No (a minor gap) | L | S |
| **Count initial Codex requests with inherited totals** (`5e8c5eb7`, #23729) | T3/apps/server/src/provider/Drivers/codexUsage.ts | **Have T3's fix** (ORQ/apps/daemon/src/usage-tokens.ts:212-240 counts an inherited first request). A **related undercount** exists: `if (total <= state.prevTotal) continue` (usage-tokens.ts:226-228) skips every turn after Codex resets its cumulative total on an app-server restart. | **Related bug (F10).** A scan of this host's rollouts found 29 of 1,720 files with a reset, about 1.1% of tokens. | M | S |
| **ChatGPT Business usage limits offer a copyable admin request** (`6f75bcb3`, #23361) | T3/apps/server/src/provider/CodexManagedErrors.ts, T3/packages/shared/src/usageLimits.ts | **N/A.** The error codes belong to T3's token-sharing provider. Orquester maps Codex limits to `usage_limit` (host/adapters/codex/normalise.ts:2168-2191) and feeds `limit-recovery.ts`. | No | L | – |
| **Older clients connect again after idle-compaction modes** (`43879d97`, #23454) | T3/packages/contracts/src/settings.ts (the legacy boolean stays on the wire) | **Connects fine.** The new fields are tolerant (ORQ/packages/config/src/index.ts:846-866). There is a **related data-loss bug**:<br>• `agentPrefsSchema` is a stripping `z.object` (packages/config/src/index.ts:796).<br>• The UI sends the whole `agents` group (ORQ/packages/ui/src/store/app.ts:1916-1928).<br>• The daemon merges top-level keys only (ORQ/apps/daemon/src/index.ts:2883-2885).<br>So an older client's next agent-pref toggle erases `claudeIdleCompaction` and the per-account overrides. | **Related bug (F9)** | M | S |

### Automation, source control and storage

| Change | T3 evidence | Orquester status (with paths) | Same bug in Orquester? | Value | Effort |
|---|---|---|---|---|---|
| **Webhook filters fan out over arrays with a `[]` wildcard** (`defb7e6e`, #23282) | T3/apps/server/src/scheduledTasks/webhookTemplate.ts, webhookFilter.ts | **Missing, and so is the webhook trigger.** Triggers are manual, schedule and git (polled) (ORQ/packages/api/src/workflows/types.ts:110-127, block-types.ts:72). The rule `contains` checks scalar array items only (ORQ/packages/api/src/workflows/rules.ts:253-256). | N/A | M (once webhooks exist) | S |
| **Export how long runs take and how they end** (`f8e48348`, #22094) | T3/apps/server/src/orchestration-v2/RunMetrics.ts, observability/Metrics.ts | **Partial.** Workflow runs store `queuedAt`, `startedAt` and `durationMs` (ORQ/packages/api/src/workflows/types.ts:380-383), and turns carry `durationMs` (ORQ/packages/api/src/agent-chat/runtime-events.ts:384). There is no OTLP, Prometheus or aggregate export. | N/A | L | M |
| **PR watches wake when the remaining CI checks finish, or when no checks report** (`09bb9f15`, `b3c01090`); **Forgejo skipped jobs no longer keep a watch pending** (`71a283ae`) | T3/apps/server/src/orchestration-v2/pullRequestWatch.ts, PullRequestWatchReactor.ts; T3/packages/source-control-forgejo/src/server/forgejoPullRequestJson.ts | **Missing.** There is no PR watch (see 06 §8). The only check data is the GitHub hover card (ORQ/apps/daemon/src/github-links/service.ts:159-187), which already counts other completed conclusions as skipped. Git triggers fire on PR open, update, merge and close only (ORQ/apps/daemon/src/workflows/triggers/git-events.ts). | N/A | H with a PR watch | S on top of one |
| **Bitbucket startup sweep no longer floods with 429s** (`c96a4bb4`, #23889). At most 4 requests in flight, one host-wide pause after a 429, and user actions bypass the pause. | T3/packages/source-control-bitbucket/src/server/BitbucketApi.ts (`throttled`, `CONCURRENCY=4`) | **Partial.**<br>• The git-trigger poller spreads its first polls over 10 s, polls bitbucket.org every 180 s, and honours Retry-After per channel (ORQ/apps/daemon/src/workflows/triggers/git-poller.ts:43-51, 329-404).<br>• There is no host-wide pause or request cap.<br>• `bbRequest` retries a 429 twice with fixed 2 s and 4 s sleeps and ignores Retry-After (ORQ/apps/daemon/src/providers/bitbucket-cloud.ts:146-150).<br>• `dcRequest` retries once (bitbucket-server.ts:189-193).<br>• A DC poll can send about 30 sequential requests (bitbucket-server.ts:661-684). | **Yes, partly (F6)** | M | S |
| **Clones retry over HTTPS when the SSH key is refused** (`a49d18cf`, #23170) | T3/apps/server/src/sourceControl/SourceControlRepositoryService.ts (`httpsFallbackUrl`, `isSshRejection`) | **Missing.** `pickCloneUrl` prefers SSH (ORQ/apps/daemon/src/accounts.ts:180-185). `cloneFromInput` and `cloneRepo` don't retry on `Permission denied (publickey)` (accounts.ts:759-800, 906-960), even though every account has a token-backed HTTPS credential store (`remoteTransport`, accounts.ts:880-898). | **Yes (F6b)** | M | S |
| **GitCafe and Forgejo fixes** (`1c8e79ec`, `f9c1d023`, `52bb5c8c`, `6e3c5e67`, `8acbefef`) | T3/packages/source-control-gitcafe/**, source-control-forgejo/** | **N/A.** There is no GitCafe or Forgejo host, and no host-API merge or PR editing. `merge_back_session` is a local git merge. | No | – | – |
| **Skip unused Git output line parsing** (`9a638026`) | T3/apps/server/src/vcs/GitVcsDriverCore.ts | **N/A.** Git runs through buffered `execFile` with no per-line callback (ORQ/apps/daemon/src/git.ts:16-24, 146-166). | No | L | – |
| **Storage cleanup no longer counts pnpm clones as freed space** (`d0e427d4`, #22713) | T3/apps/server/src/storageCleanup.ts (`sharedPnpmVirtualStore`) | **Missing:** there is no storage cleanup or "space freed" feature. The only figure is total and used disk (ORQ/apps/daemon/src/system-status.ts:1014). | N/A | L | – |
| **SSH hosts no longer keep every old 300 MB runtime** (`ff525478`, #23113) | T3/apps/server/src/cloud/selfUpdate.ts (`pruneRuntimesOnStart`) | **N/A.**<br>• Deploy updates in place (ORQ/deploy/lib/remote-update.sh:53-56).<br>• `orq-agent` removes its `.old` binary (ORQ/apps/box-agent/internal/agent/update.go:175).<br>• Box tooling prunes old versions (ORQ/apps/daemon/src/boxes/tooling/provisioner.ts:260-285).<br>• One small leftover: a tool switched `off` keeps its old versions (provisioner.ts:252-256). | No | L | – |

## 2. Worth copying or fixing, ranked

### F1. A Stop doesn't stick: stopped delegates wake the parent the user just stopped (H, S-M)

This is the T3 class from `fbc6a081` and `6a6c84f9`, verified by reading the code paths.

`create_session {delegate:true}` defaults to `reply:"notify"` (ORQ/apps/daemon/src/mcp/tools/messages.ts:878-880). Suppose the parent P ends its turn ("I've delegated X, I'll report back") while the delegate C works, and the user presses Stop on P:

1. `DelegateStopCascade` interrupts C, with cause `parent-stopped` (delegates.ts:141-153).
2. C's bound turn settles `interrupted`.
3. The router builds a delivery with outcome `interrupted` (replies.ts:1767-1769) and hands it to P's delivery queue (replies.ts:1810+).
4. P is idle, so `isIdle` holds (lineage.ts:578-592) and the notice is posted at once as a new turn: `"Task: …"'s turn was interrupted before it replied.`
5. P's agent starts again, usually re-delegating or doing the work itself, right after the user said stop.

The same happens if P was running `wait_for_session`: the Stop cancels the wait, the subscription drops to `notify` (replies.ts:18-21), and the reply still comes. Nothing in `replies.ts` or `lineage.ts` reads `parent-stopped`; its only consumer is the child's timeline row. The tests don't combine the cascade with the router: `delegates.test.ts` has no `ReplyRouter`, and the `replies.test.ts` delegate tests cover attention only.

**Port sketch:**
- Add a `ReplyRouter.requesterStopped(rootId, childIds)` hook.
- In `DelegateStopCascade.start`, call it before the interrupts are posted. It marks every open subscription with `fromThreadId === rootId` and `toThreadId ∈ childIds` as `done`, with a new `ended: "stopped"`, persisted before the interrupts. When the bound turn later settles, no delivery is made.
- Drop any `pending` or `queued` delivery from those children to `rootId`, the way `dropNoticesTo` already does (replies.ts:1181-1190).
- Optionally, follow T3 for a direct Stop on the delegate as well: deliver a non-waking note rather than starting a turn on an idle parent.
- Test: run a cascade with a notify subscription and an idle parent, and assert that no `/turn` is posted to the parent.

### F2. Provider CLIs can outlive a crashed agent host, and crash-safe resume then starts a second agent (H, M; verify live)

This is the T3 class from `5ffe0459`.

After an unexpected host death (OOM kill, crash), the next host folds every head that still reads `running` and **resumes** it (host/README.md "Boot order" step 2, `MAX_CRASH_RESUME_ATTEMPTS`). Nothing stops the previous CLI first:

- **OpenCode.** `opencode serve` is `detached` (its own session, host/support/spawn.ts:122) and is an HTTP server. It has no reason to notice its parent died, and it keeps running the in-flight session loop. The new host starts another server on a new port and posts "continue" to the same upstream session, with the session store shared through `XDG_DATA_HOME`.
- **Claude.** The SDK spawns the CLI in the host's process group. T3 observed that the CLI finishes its current turn after its pipes close. Whether the tmux pane's SIGHUP reaches it depends on whether node was the session leader: **unverified**.
- **Codex and Grok.** Both are `detached`. Whether they exit on stdin EOF, and whether they abort the in-flight turn when they do, is **unverified**.

The result is two agents editing one worktree, and two transcripts racing on one provider session.

**Port sketch:**
- Copy T3's lifeline. Spawn through `/bin/sh -c '{ trap "" TERM; read -r _ <&3; kill -TERM 0; sleep 5; kill -KILL 0; } </dev/null >/dev/null 2>&1 & exec "$@" 3<&-'`, with a fourth stdio pipe that only the host holds.
- For Claude, pass it as `spawnClaudeCodeProcess` locally. That also needs `detached: true`, so `kill -TERM 0` hits only the CLI's group.
- For the others, add it to `spawnProviderChild` behind an option.
- Belt and braces: at boot, before resuming an orphan, run `stopLeftoverProcesses` on the thread's previous launch id. The marker is already in every provider's env (host/support/env.ts). It needs the launch id and the session leader recorded in `launch.json` at start.
- Live check: on a scratch appdir, `kill -9` the host mid-turn and look for the old CLI with `ps -e -o pid,sid,args | grep ORQUESTER_AGENT_LAUNCH`.

### F3. Daemons that tools `setsid` away (agent-browser plus Chrome, MCP-server grandchildren) outlive Claude, Codex and OpenCode sessions (M, M)

This is the T3 class from `1aa71796`, and from the earlier #3089.

Only Grok sweeps by launch marker. For the other three:
- A session end kills the CLI, or its group, and nothing else.
- When the CLI exits by itself, `spawnProviderChild.kill` is a no-op (spawn.ts:181-183), so even same-group MCP grandchildren survive.

**Caveat:** this host runs one deliberately shared Chromium for agent-browser (see the host CLAUDE.md). A per-launch reap would kill the shared browser when the session that first started it ends. Scope the sweep to processes whose marker matches the ending launch **and** that are not on an allowlist (agent-browser's daemon), or make it a per-agent setting.

**Port sketch:**
- Generalise Grok's `recordChildSessions` + `stopLeftoverProcesses` (host/support/leftover-processes.ts) into an adapter-agnostic `onSessionEnded` step in the orchestrator.
- On every provider exit, natural ones included, `SIGKILL` the remainder of the provider's own group.

### F4. A redirect over a Claude subagent's approval loses the user's words (M, S)

This is the T3 class from `b7e802bd`.

A subagent, the Task tool, asks for approval, and the user types a redirect. The subagent receives "follow the user's new message" (host/adapter.ts:336-337), but the message is steered into the **main** agent (wire.ts:696-709). The subagent never sees it and improvises or gives up.

**Port sketch:**
- Thread the redirect text through `settle(decision, redirect)` (host/adapters/claude/session.ts:1739-1740, 1988).
- In `permissionResultForDecision` (decisions.ts:72-81), return `{behavior:"deny", message: <user text, trimmed, capped>}`.
- When the request belongs to a subagent (its tool use has a parent tool-use id), skip the steer.
- Refuse attachments in that case, as T3 does.
- Keep today's behaviour for main-agent requests.

### F5. A reconnect replays by reading the whole log (M, S)

This is the analogue of `d7a8d6f3`. `measureReplay` → `readTail` reads and decodes all of `events.ndjson` on every `events?after=N` reconnect, even when nothing is new (host/store/index.ts:1162-1170). Many open chats reconnecting together after a network blip each parse their full log.

**Port sketch:**
- Return `[]` when `afterSeq === runtime.state.seq`.
- Otherwise use `store.readEventsFrom` from a small seq→byte ring filled by `append`'s `positions`, falling back to `readTail` on `mismatch`.

### F6. Bitbucket 429 amplification (M, S) and no HTTPS retry when the SSH key is refused (M, S)

These match `c96a4bb4` and `a49d18cf`.

**Bitbucket throttle:**
- Add a host-plus-account `HostRateGate` in `ORQ/apps/daemon/src/providers/`: a 4-slot semaphore and `pausedUntil`, set from Retry-After or 60 s.
- Background GETs that arrive during a pause fail fast with a `rate_limited` `GitRemoteError` carrying `retryAfterMs`. The poller already honours it (git-poller.ts:391-403).
- User routes bypass the pause.
- Remove the fixed in-request sleep-retries, which also removes a sleep-based wait.

**Clone fallback:** in `cloneFromInput` and `cloneCreatedRepo` (accounts.ts), when an SSH clone fails with `/Permission denied \(publickey\)|Host key verification failed/` and `urls.https` exists:
- remove the partial directory;
- retry once over HTTPS, since `remoteTransport` already switches to the credential store;
- report both errors if the retry fails too.

### F7. A Codex native child that finishes after the parent's turn ended never wakes the parent (M, M)

This is `11adcb0e`.

**Port sketch:**
- In the Codex session, when a child of the root thread (not a grandchild) reaches `completed` or `failed`, and the parent has no active turn and no non-completed terminal turn, ask the orchestrator for a provider-initiated wake turn on the parent.
- Its text is "Subagent <status>: <label>\n\nResult:\n<result>".
- It should go through the same `ifIdle` and receipt path the delivery queue uses, so a user message wins.

### F8. A delegate's reply arrives before its background work settles (M, M)

This is `163bdeaa`.

**Port sketch:**
- In the reply router, when the bound turn settles while the child's summary shows `backgroundLiveness === "working"` (the field `delegateUnfinished` already reads), hold the claim.
- Bind the subscription to the next turn that settles once the roster is empty, with a cap of one extension and a timeout notice.
- Alternatively, deliver now with a "background work still running" note and then deliver once more when it settles.

### F9. An older client wipes newer `agents` prefs (M, S)

This is related to `43879d97`.

**Port sketch:**
- In `PUT /api/config/app` (ORQ/apps/daemon/src/index.ts:2883-2885), merge `agents` field-wise: `{...current.agents, ...body.agents}`.
- Make `agentPrefsSchema` `.passthrough()` (packages/config/src/index.ts:796), as AGENTS.md requires for tolerant stores.

### F10. Codex token usage undercounts after a counter reset (M, S)

**Port sketch:**
- In `parseCodexFile` (usage-tokens.ts:226-228), treat `total === last.total_tokens` as a restart: bill it and reset `prevTotal`.
- Bump the cached entry version so past rollouts are re-parsed.

### F11. An OpenCode catalog failure is cached for 5 minutes (L-M, S)

**Port sketch:**
- Use a 15 s TTL for non-`ready` snapshots in host/adapters/opencode/index.ts:562-565.
- Optionally, let the registry interval re-probe `error` snapshots with no watchers.

### F12. Grok: a clean CLI exit mid-turn reads as `completed` (L-M, S)

**Port sketch:**
- In `settleEverythingForExit` (host/adapters/grok/session.ts:2118-2129), when the host didn't initiate the exit, settle with `stopReason:"cancelled"`, which reads as `interrupted`, so limit recovery and the continue-after-restart logic see it.
- Add a lifecycle test.

## 3. Skip, and why

- **SQLite reader split, shell-snapshot query speed-up, and keeping subagent transcripts off the shell stream** (`6ed47b53`, `c7e3993f`, `fd1063ba`). These fix T3's projection database, which Orquester doesn't have. Our index is a per-thread disposable cache, and the bus carries coarse transitions only.
- **Managed Codex token broker** (`478fdfc0`, `f5cf9a02`). Orquester's box broker and the CLI's own refresh already cover it.
- **CLIProxyAPI usage, Codex sign-in hint in usage notices, and the ChatGPT Business admin request** (`7e52513a`, `53245cce`, `6f75bcb3`). These belong to integrations or error codes Orquester doesn't have.
- **Pi and Cursor fixes** (`6d9ec7bd`, `aa0158d0`, `656f3f40`). Orquester has no such providers. The one useful analogue is F12.
- **ACP MCP fetch abort** (`e64a6d4c`). Already covered by the session-tools endpoint and forwarder.
- **Windows async env probe, the RPC typing workaround, and git line-parse perf** (`f460ddb2`, `cf3acd90`, `9a638026`). Not applicable to Orquester's stack.
- **Abandoned turns** (`6f6f68ad`). Already handled: an errored session is stopped before reuse (orchestrator.ts:1795-1809).
- **Idle orphaned follow-ups** (#22581). Orquester has no parent-side task record to get stuck.
- **GitCafe and Forgejo** (`1c8e79ec`, `f9c1d023`, `52bb5c8c`, `6e3c5e67`, `8acbefef`, `71a283ae`). Orquester doesn't support these hosts.
- **PR-watch wake rules** (`09bb9f15`, `b3c01090`). Copy them only together with the PR watch itself (06 §8). The rules are small and worth taking then: wake again when optional checks finish (`owedChecks`), and wake with "no checks reported" after 15 minutes.
- **Webhook `[]` wildcard** (`defb7e6e`). Wait until a webhook trigger exists; the semantics are worth copying then. Meanwhile, a `pluck`/`any` in `ORQ/packages/api/src/workflows/expressions.ts` would serve the same need for git-trigger payloads.
- **Run metrics export** (`f8e48348`). There is no metrics pipeline to feed; the durations are already stored.
- **Storage cleanup and pnpm clones, and old runtime pruning** (`d0e427d4`, `ff525478`). Orquester has no storage-cleanup feature and no versioned runtimes.
