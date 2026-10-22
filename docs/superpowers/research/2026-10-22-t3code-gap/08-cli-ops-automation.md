# 08 — CLI, operations, automation and observability: T3 Code vs Orquester

Analyst domain: the `t3` CLI, install/service/update, release channels, observability and
telemetry, and automation (scheduled/webhook tasks vs Orquester workflows).

- T3 paths are relative to `t3code_codebase/` (HEAD `ed9b7ca9`). Orquester paths are relative to the repo root.
- "(new)" marks work that landed in `e8d87689..ed9b7ca9`. The T3 history is squashed at `e8d87689`,
  so everything else already existed at the base commit.
- I checked every claim in source, not only in docs. Line numbers are approximate anchors.

---

## 1. They have, we don't

| Feature | T3 evidence (paths) | Orquester status (evidence) | User value | Port effort |
|---|---|---|---|---|
| **Inbound webhook trigger for automations**: per-task URL with a token, optional HMAC-SHA256 signature, body cap, outcome header | `apps/server/src/scheduledTasks/webhookRoute.ts` (1 MiB cap at l.18, `x-t3-hook-outcome` header, 202/401/404/409/410/429 mapping at l.113-129); `webhookVerification.ts` (constant-time HMAC, hex/base64, prefix); `packages/contracts/src/scheduledTask.ts:149-186`; token rotation `ScheduledTaskRotateWebhookTokenInput` | **Missing.** The workflow spec rules it out on purpose ("Polling only … no public webhook endpoint", `docs/superpowers/specs/2026-09-28-automated-workflows-design.md` §1.2 and §1.3). The trigger kinds are only `trigger.manual`, `trigger.schedule` and `trigger.git` (`packages/api/src/workflows/types.ts:110-127`). The git trigger is described as "Polled, never a webhook" (`packages/api/src/workflows/block-types.ts:72`). The outbound HTTP block exists (`apps/daemon/src/workflows/nodes/http.ts`). | H | M |
| **Webhook event filters** (new, `0c85b0d9`): up to 16 `{path, op}` tests with ops `equals`, `notEquals`, `startsWith`, `in` and `exists` over `body.*`, `headers.*` and `query.*`. A request runs only if every filter matches. Non-matching requests get a 202, are logged as `filtered` with the first failing filter, and start nothing. | `apps/server/src/scheduledTasks/webhookFilter.ts` (49 lines); schema `scheduledTask.ts:106-147`; pipeline `ScheduledTaskService.ts:~1846-1862` | **Missing as a trigger-level pre-filter.** You can approximate it with an IF or Switch block after the trigger, but each non-matching event still creates a run. Git triggers do have built-in filters (branch globs, tag pattern, PR actions and base branches; spec §6.2, `apps/daemon/src/workflows/triggers/git-events.ts`). | H (with webhooks) | S (once webhooks exist) |
| **Webhook replay dedupe and coalescing** (new, `2ebe280e`) | `apps/server/src/scheduledTasks/webhookDedupe.ts`; migration `persistence/Migrations/067_WebhookDedupe.ts`; dispatcher `ScheduledTaskService.ts:2063-2151` (see §2.1 for the full mechanics) | **Missing for inbound events.** Git triggers already dedupe with a 1,000-key fired ring and transition keys (`git-events.ts:28,295-297`) and coalesce pushes between polls (spec §6.2). | H (with webhooks) | M |
| **Webhook delivery log**: per-task "Deliveries" view showing method, content type, size, outcome, whether the signature was verified, missing placeholders, the redacted headers and body, and the rendered prompt | Contracts `scheduledTask.ts:316-383`; storage and retention `ScheduledTaskService.ts:72-78,1398-1480`; UI `apps/web/src/components/settings/ScheduledTasksSettings.tsx` | Missing. The closest is workflow run history, which keeps `triggerPayload` per run (`packages/api/src/workflows/types.ts:405`). | M | S-M |
| **`t3 thread` CLI** (new, `955b4cc8`): `start <project> "msg" [--worktree]`, `send <id> msg --wait` (exits 1 if the run fails, 2 if it waits on the user; `-` reads stdin), `show`, `list`, `--json` | `apps/server/src/cli/thread.ts` (710 lines); `docs/user/outside-agents.md:97-116` | **Partial.** The same operations exist as MCP tools (`create_session`, `send_message`, `wait_for_session`, `read_transcript`; `docs/orquester-mcp.md`), but only at `POST /mcp` on the password-authenticated remote transport. There is no shell CLI: `apps/daemon/src/cli.ts` (35 lines) only starts the daemon with `--appdir` (`index.ts:5285`). | M | S-M |
| **Packaged CLI and installers**: `curl …/install.sh \| sh`, `install.ps1`, `npx t3@latest`, a desktop "Install t3 command" button, and `t3 uninstall` | `scripts/install.sh`, `scripts/install.ps1`, `scripts/npm-launcher/`, `apps/server/src/cli/uninstall.ts`; `docs/user/install.md` | **Partial.** Setup is `git clone` + `pnpm install` (README "Getting started"). The only server installer is `./deploy.sh provision` (Ubuntu VPS, root, system unit). There is no package version (`apps/daemon/package.json` is `0.0.0`) and no uninstall. | M | L |
| **User-level background service**: `t3 service install`, `status`, `restart`, `uninstall` using systemd `--user` plus linger on Linux and launchd on macOS. Includes a `service.env` overlay and status codes (`linger-disabled`, `restart-pending`, …) with repair hints. | `apps/server/src/cli/service.ts`, `apps/server/src/cloud/bootService.ts` (launchctl at l.335-358), `cli/servicePreflight.ts`; `docs/user/background-service.md` | **Partial.** There is a system-wide hardened unit, `deploy/orquester.service`, installed by `deploy/lib/remote-provision.sh`, with `KillMode=process` so tmux survives. No per-user or macOS service, and no CLI status or repair. | M | M |
| **Self-update with release channels**: `t3 update [version] [--channel stable\|nightly\|preview] [--allow-downgrade] [--yes]`. A preview build needs confirmation. The service launcher runs the new runtime as a **trial**, commits it only after it reports `prepared`, and otherwise rolls back, including a SQLite main/WAL/SHM snapshot. A disk-space precheck runs before the snapshot. An "update everything" button covers servers, providers and desktop. | `apps/server/src/cli/update.ts:196-240,330-346`; `apps/server/src/serviceLauncher.ts:46,298,583,753-778`; `docs/internals/server-updates.md`; `docs/user/updating.md` | **Partial.** `./deploy.sh deploy\|rollback <sha>` is run by the operator from a dev machine (`deploy.sh:103-124`). There are no channels; deploys follow a git branch (`targets.conf` `branch=`). **No automatic revert**: `remote-update.sh` restarts first and checks `/health` afterwards. If that fails, `set -e` aborts with the new code still running (`deploy/lib/remote-update.sh:73-75`). `/api/info` reports no version or commit (`index.ts:2063-2073`, `packages/api/src/index.ts:93-103`). | M | S (auto-revert) / L (channels) |
| **`t3 doctor`**: inspects the DB, shows reclaimable bytes, offers repairs (switch to incremental `auto_vacuum` with a VACUUM, delete the pre-0.1.0 DB), pauses the service around the repair, and supports `--fix`, `--dry-run` and an interactive multiselect. Settings > Storage nudges at ≥1 GiB. | `apps/server/src/cli/doctor.ts`; `apps/server/src/persistence/DatabaseMaintenance.ts:83-120,183-194` (1 change in range); `docs/user/background-service.md` §Reclaim | **Not applicable as-is.** Orquester's only SQLite file is a disposable thread-index cache rebuilt from `events.ndjson` (AGENTS.md "Runtime boundaries"; README "Architecture"). The underlying need, a doctor for disk and host health, is **missing**: nothing reports appdir or threads-dir size, and nothing prunes daemon logs (see the log row). | L-M | S-M |
| **Local trace file, `t3 trace summary`, and a Diagnostics UI** showing latest failures, most common failures, slowest spans, span logs and top span names | `docs/operations/observability.md` (NDJSON trace at `<home>/userdata/logs/server.trace.ndjson`, rotated); `apps/server/src/cli/trace.ts:150-195`; `apps/server/src/diagnostics/TraceDiagnostics.ts`; UI `apps/web/src/components/settings/DiagnosticsSettings.tsx:1077-1315` | **Missing.** The daemon has Fastify/pino request logs plus `console.*`, which goes to journald under systemd. There is no spans, error summary or UI log view, and `./deploy.sh logs` only tails the journal (`deploy.sh:245-251`). | M | M |
| **Event-loop stall monitor**: samples every 30 s and records a `server.eventLoop.stall` span if the delay exceeded 2 s. The span includes CPU user/sys, page faults and context switches. Stalls are also appended to `event-loop-stalls.ndjson` (≥1000 lines plus one backup). | `apps/server/src/observability/EventLoopMonitor.ts`; `docs/operations/observability.md` §Event Loop Stalls | **Missing.** No `monitorEventLoopDelay` or stall detection in `apps/daemon/src`. | M | S |
| **OpenTelemetry export** (traces, metrics, logs) set per environment in Settings > Diagnostics with a **Test** button that sends an empty export; env overrides `T3CODE_OTLP_*` / `OTEL_EXPORTER_OTLP_*`; 16 metric instruments | `apps/server/src/observability/{Observability,Metrics,OtlpEndpointCheck}.ts`; `apps/web/src/components/settings/TelemetryExportSettings.tsx`; `docs/user/telemetry.md` §Export | **Missing.** No OTLP or metrics anywhere. | L-M | M |
| **Resource telemetry with history**: a native Rust monitor that samples only while someone is watching, process-group metrics exported over OTLP (new, `86d130af`), and a "Resource History" panel | `apps/server/src/resourceTelemetry/*`, `ProcessGroupMetrics.ts`; `docs/internals/resource-telemetry.md` | **Partial (good).** Settings > Host status shows live CPU, memory, disk, network, the managed process tree with kill, and listening ports (`apps/daemon/src/system-status.ts`, `packages/ui/src/components/settings/HostStatusSettings.tsx`). History is only client-side sparklines while the page is open (`packages/ui/src/components/system/sparkline.tsx`). Linux only. | L | M |
| **`t3 connect` reachability check** (new, `91d7bf3e`, plus `e0092765` actionable errors): probes the Cloudflare tunnel edge on :7844, DNS and the public endpoint, and re-checks every 5 min | `apps/server/src/cloud/ConnectReachability.ts` (312 lines); `apps/server/src/cli/connect.ts`; `docs/user/t3-connect-troubleshooting.md` | **Partial.** `deploy.sh provision` curls `https://<domain>/api/auth/info` once (`deploy.sh:186-187`), and every deploy runs a headless smoke test (`scripts/smoke-web.mjs`). The running daemon never checks that its public URL works. Remote access is mostly another analyst's domain. | L-M | S-M |
| **Recurring prompt into an existing thread**: a "thread automation" task bound to a `threadId`, deleted along with its thread | `ScheduledTask.threadId` (`scheduledTask.ts:240`); `deleteForThread` (`ScheduledTaskService.ts:241`); `2edeeda6`, `48745ffb` (new) | **Missing.** A workflow agent block can only start a `new` session or `continue` a session made earlier in the same run (spec §5.1; `packages/api/src/workflows/validate.ts:646`). It cannot target a chat the user already has open. | M | M |
| **`t3 triage`**: runs `claude` or `codex` against the local T3 home to diagnose a T3 problem and draft a good issue | `apps/server/src/cli/triage.ts:144-157`, `triagePrompt.ts` | Missing. | L | S |
| **Live background-work verifier**: a real-provider e2e script with an evidence directory and a `--fail-gate` self-test | `docs/operations/background-verification.md`; `apps/server/scripts/verify-background-live.ts` | **Partial.** Workflows have fake-backed e2e tests (`apps/daemon/src/workflows/e2e*.test.ts`) but no live-provider verifier. | L | M |
| **Hold webhooks while offline**: the relay stores deliveries for 24 h; each task has `maxDeliveryAgeMinutes`, and relay delivery IDs are deduped in their own table for 48 h | `contracts/src/relay.ts:1174`; `ScheduledTaskService.ts:~1735-1770` | N/A. There is no relay, and Orquester's daemon is reachable directly through Caddy. | L | — |
| Product analytics (PostHog through `ingest.t3.codes`, a hashed install id and install owner, new in `e2875821`) | `apps/server/src/telemetry/*`; `docs/internals/product-analytics.md` | None, and **not recommended**. See §4. | — | — |

---

## 2. They do it better

### 2.1 Webhook automation pipeline (new filters and dedupe)
In both products automation is a first-class feature. T3's inbound path is carefully hardened and
bounded. The order in `ScheduledTaskService.triggerWebhook` (`ScheduledTaskService.ts:1668-1960`) is:

1. Look up the task by hookId and compare the token in constant time. Any mismatch returns 404.
2. **Relay claim**: if the request carries a signed `x-t3-relay-delivery-id` proof
   (`RelayDeliveryProof.ts`), it is inserted into `scheduled_task_webhook_relay_deliveries` with
   `ON CONFLICT DO NOTHING`. A conflict means it was already seen, so the outcome is `duplicate`.
   Claims older than 48 h are purged. A claim is released if the request is later rate-limited,
   so the relay's retry is not treated as delivered.
3. **Rejection flood gate** before any signature work: a 60/min sliding window per task. Valid
   deliveries refund their slot afterwards.
4. Disabled → 409. **HMAC check** (`webhookVerification.ts`) → 401. **Max age**: a
   relay-held request older than `maxDeliveryAgeMinutes` → 410. The relay's `receivedAt` is clamped
   so it can never be later than now.
5. **Filters** (`webhookFilter.ts`): the first failing filter is logged as "Filter N (path) did not
   match." Filtered rows have their own log rate limit of 10/min and retention of 20.
6. **Dedupe** (`webhookDedupe.ts`), inside a SQL transaction:
   - *Replay key*: a template such as `{{headers.x-github-delivery}}` is rendered, then
     SHA-256 hashed. If `(task_id, replay_key)` exists with `expires_at > now`, the outcome is
     `duplicate`. Keys live **7 days** (`claimReplayKey`). If any placeholder is missing or the
     render is empty, the rule is skipped (an empty key).
   - *Coalesce key*: if a `pending` row exists for `(task_id, coalesce_key)` whose `due_at` is
     still in the future, the new request **replaces** the stored request JSON, appends its
     delivery id to `delivery_ids_json`, and returns `coalesced`. The window is fixed from the
     first delivery (later ones do not extend it): 10–3600 s, default 120.
     Otherwise a new pending row is inserted with `due_at = now + window`, after a capacity check
     of at most 20 queued per task (`queue_full` → 429). Expired windows are flipped to
     `dispatching` and treated as immutable. A scheduler job, `webhook-coalescing`
     (`ScheduledTaskService.ts:2063-2151`), dispatches due rows using the **latest** body. Pending
     windows survive a restart because they live in SQLite.
   - Duplicate and coalesced log rows share a budget of 10/min per task, and coalesced
     validations count against the 60/min limit.
7. Rendering (`webhookTemplate.ts`): every placeholder value is wrapped in
   `<webhook-data-ID>` tags, where the ID is a fresh random value per request. Mentions are
   neutralized: a word joiner is inserted after `$`/currency signs and `@`, after a lone `/word`,
   and inside `t3-context:` (regex `MENTION`, l.70), so `$skill`, `@file` and `/command` from a
   payload cannot fire. Credential-looking headers and query parameters are redacted wherever
   the full set renders (`CREDENTIAL_NAME`, l.26). An over-long prompt is logged as
   `prompt_too_long`.
8. Logs are bounded: 50 main, 20 dedupe and 20 filtered rows per task, with body and prompt
   capped at 64 KiB (`ScheduledTaskService.ts:72-78`). Clients send `acceptAnyOutcome` so new
   outcome strings do not break older clients (`scheduledTask.ts:355-366`), which matches
   Orquester's "tolerate other app versions" rule.

Orquester has no inbound path. Its git trigger's untrusted-text handling is an **editor warning**
(`untrusted_prompt_input`, `packages/api/src/workflows/validate.ts:516`) plus escaping that only
stops `{variable}` injection (`apps/daemon/src/workflows/agent/prompt.ts:104-110`). A PR title like
`$deploy` or `@~/.ssh/id_rsa` reaches the agent unchanged. T3's runtime framing and mention
neutralization is clearly stronger and applies directly to Orquester's PR and release payloads
today.

### 2.2 Update safety
T3's launcher (`serviceLauncher.ts`, `docs/internals/server-updates.md`) gives a durable,
two-phase guarantee:
- It records a pending update and snapshots SQLite (main, WAL, SHM) after checking for free disk.
- It starts the new version as a trial. The trial must finish migrations, bind HTTP and park
  every root before reporting `prepared`.
- Only then does the launcher commit. A timeout or crash rolls back, and the restore is protected
  by a durable marker.

In Orquester, `deploy/lib/remote-update.sh` does `git reset --hard` → install → build → native-module
guard → `systemctl restart` → `curl /health` for up to 150 s. If health never comes back, the script
fails but leaves the new code running. Recovery is a manual `./deploy.sh rollback <target> <sha>`,
which rebuilds again. The native-module pre-restart guard (`scripts/ensure-node-native.mjs`) is a
good partial protection, but nothing covers a daemon that starts and then fails health.

### 2.3 Service ergonomics and diagnosability
`t3 service status` reports named failure states and prints the exact repair command
(`docs/user/background-service.md` §Troubleshooting). Linger is enabled automatically with a
fallback hint, and a `service.env` overlay survives reinstalls. Orquester's unit is solid but
VPS-only and root-provisioned. Status means `ssh` + `systemctl` or `./deploy.sh verify`, which
prints HEAD, health, service, bundle hash and Go (`deploy.sh:229-243`).

### 2.4 Logs and traces
T3 always writes a structured, rotated trace file and can summarize it offline
(`t3 trace summary --since 30m`), even while the server is stalled. Its Diagnostics page shows
failures and slow spans. Orquester's daemon log stream is opened **once at startup**:
`createWriteStream(dailyLogFile(resolved.logsDir))` at `apps/daemon/src/index.ts:518`, with
`dailyLogFile` in `packages/config/src/index.ts:589`. A daemon that runs for weeks keeps writing to
the file named for its start date, and old daily files are never pruned. Agent-host raw logs are
pruned (`apps/daemon/src/agent-host/store/raw-log.ts:377`), but daemon logs are not.

### 2.5 CLI surface for scripting
`t3 thread start/send --wait/show/list` works on the host **without sign-in**, through the local
trust boundary, and has script-friendly exit codes. Orquester exposes the same capability only
through an MCP client against the authenticated remote `/mcp`. The local Unix socket, Orquester's
trusted control path, has no CLI on top of it.

---

## 3. Worth copying (ranked by value/effort)

1. **Untrusted-payload framing for agent prompts. Value H, effort S.**
   Land it in `apps/daemon/src/workflows/agent/prompt.ts`: extend the existing `escapeValue` hook
   passed to `renderTemplate`. Values that come from `trigger.*` (PR title/body, release body, and
   later webhook data) should be wrapped in `<trigger-data-RANDOM>` frames plus a closing note.
   Neutralize `$`/`@`/lone `/word` with a word joiner. Put the pure helper in `packages/api` next to
   `escapePromptVariables` so the UI preview matches. Crib `MENTION` and the frame logic from
   `apps/server/src/scheduledTasks/webhookTemplate.ts:57-179` (MIT, keep attribution). Keep the
   current `untrusted_prompt_input` editor warning.

2. **Webhook trigger for workflows (`trigger.webhook`). Value H, effort M.**
   - Contracts: add the node type and config `{signature?: {header, encoding, prefix,
     secretName}, filters?, dedupe?: {replayKey?, coalesceKey?, coalesceWindowSeconds?},
     maxPerMinute}` to `packages/api/src/workflows/types.ts`, `block-types.ts` and `validate.ts`.
     Add the persisted shape to `packages/config/src/workflows.ts`. The HMAC secret goes in the
     existing `WorkflowSecretsService` (`apps/daemon/src/workflows/secrets.ts`), which persists
     names only.
   - Route: add a public `POST|PUT|GET /hooks/:hookId/:token` exempted by **route pattern** in the
     `onRequest` hook (`apps/daemon/src/index.ts:1964-2001`), the same way `AGENT_VISUAL_ROUTE_PATTERN`
     and `BOX_HUB_PUBLIC_ROUTES` are. Read the raw body with a 1 MiB cap. Mint tokens with
     `crypto.randomBytes` and offer rotation.
   - Engine: create `apps/daemon/src/workflows/triggers/webhook.ts` and call the existing fire path
     (overlap policy applies). Persist replay keys (7-day TTL) and pending coalesce windows in
     `workflow-state.json` through `state-store.ts`, not SQLite, and **persist the pending window
     before acknowledging**, per the AGENTS.md rule on wait state. Arm the window with the
     engine's injected clock, not sleeps. Record filtered, duplicate and coalesced deliveries as
     run stubs, the same way `skipped_overlap` is recorded, or keep a bounded per-trigger delivery
     ring for a "Deliveries" panel.
   - Crib `webhookVerification.ts` (32 lines, near verbatim), `webhookFilter.ts` (49 lines),
     `webhookExpressionResolver` and `redactHeaders`/`redactQuery` from `webhookTemplate.ts`, and
     the dedupe algorithm from `webhookDedupe.ts` (port the SQL to JSON). Copy the bounded-log
     constants from `ScheduledTaskService.ts:72-81`.
   - Caddy already exposes the daemon publicly, so Orquester needs no relay. Document that a
     webhook URL needs remote access turned on.

3. **Auto-revert on failed deploy, and version reporting. Value M, effort S.**
   In `deploy/lib/remote-update.sh`: if the post-restart `/health` wait fails, reset to `$old_head`
   (or the `orq-last-deployed-head` state file), re-run install, build and the native guard,
   restart, and exit non-zero with "rolled back". Add `version`/`commit` to `ServerInfoResponse`
   (`packages/api/src/index.ts:93`, daemon `index.ts:2063`) so `deploy.sh verify` and the UI can
   show what is running. Crib the trial→commit idea from `docs/internals/server-updates.md`. A
   full launcher port is L and not needed for a git-deployed daemon whose durable state is
   append-only NDJSON.

4. **Local `orq` CLI over the Unix socket. Value M, effort S-M.**
   Turn `apps/daemon/src/cli.ts` into a dispatcher. With no subcommand (or `serve`), keep today's
   behavior. Add `orq chat start <path> "msg"`, `orq chat send <id> msg --wait [--json]`,
   `orq chat show <id>`, `orq chat list`, `orq status` and `orq logs`, all calling existing REST
   routes through the reference client in `packages/api` over the trusted socket. No new
   transport or auth is needed, and the `/mcp` endpoint is untouched. Copy the UX from
   `apps/server/src/cli/thread.ts`: `-` for stdin, exit 1 on failure and 2 when waiting on the
   user, never interrupt a busy chat. The waits should use the existing
   `wait_for_session` semantics, not polling with sleeps.

5. **Event-loop stall monitor. Value M, effort S.**
   Create `apps/daemon/src/event-loop-monitor.ts` using `perf_hooks.monitorEventLoopDelay`,
   `process.cpuUsage` and `process.resourceUsage` on an unref'd 30 s timer. Above 2 s, log a warning
   and append one NDJSON line to `<logsDir>/event-loop-stalls.ndjson` with a bounded size and one
   backup. Show the recent count in Host status (`HostStatusSettings.tsx`). Crib thresholds and
   the "busy, not asleep" filtering from `apps/server/src/observability/EventLoopMonitor.ts` and
   `docs/operations/observability.md` §Event Loop Stalls. Also run it inside the agent host.

6. **Log hygiene plus a "Recent errors" view. Value M, effort M.**
   Fix `index.ts:518`: roll the stream over at local midnight and prune `logsDir` files older than
   N days. Put the path helpers in `packages/config`. Then add a small diagnostics route that tails
   the current log for `level >= 40` entries, grouped by message, behind auth. Show it in Host
   status. Crib the summary shapes (latest failures, most common failures, slowest spans) from
   `apps/server/src/diagnostics/TraceDiagnostics.ts` and `DiagnosticsSettings.tsx:1077-1315`.
   Full span tracing and OTLP (`Observability.ts`) can come later.

7. **Recurring prompt into an existing chat. Value M, effort M.**
   Allow `session: {kind: "existing", sessionId}` in the agent-block config
   (`packages/api/src/workflows/types.ts`, `validate.ts:646`) and handle it in
   `apps/daemon/src/workflows/agent/executor.ts`. A busy chat should queue the message as its next
   turn, as `t3 thread send` does. Disable or flag the workflow when the session is deleted, the
   way T3 handles `deleteForThread` (`ScheduledTaskService.ts:241`, `2edeeda6`). This would also
   allow a "Repeat this prompt every …" entry from a chat's menu.

8. **`orq doctor`. Value L-M, effort S-M.**
   Model it on `apps/server/src/cli/doctor.ts`: inspect, list repairs with a `recommended` flag,
   and support `--fix`, `--dry-run` and an interactive multiselect. Orquester checks would be:
   - tmux ≥ 3.2
   - native modules load (reuse `scripts/ensure-node-native.mjs`)
   - appdir, threads-dir and logs size, and free disk (reuse `statfs` in `system-status.ts`)
   - stale daily logs
   - SQLite thread-index cache size, with "rebuild cache" as a safe repair because it is disposable
   - live Caddyfile drift from `deploy/Caddyfile`
   - Go toolchain present

   Ship it as a subcommand of the CLI in item 4.

---

## 4. We do it better / they lack

- **Automation engine scope.** T3 "scheduled tasks" send one prompt to one thread, with triggers
  limited to `interval` (≥60 s), `fixed_time` (HH:MM plus weekdays) or `webhook`
  (`packages/contracts/src/scheduledTask.ts:33-57,189-201`). Orquester workflows are a real graph:
  - Blocks: agent, JS code, shell, HTTP, IF, Switch, Merge, Wait, Stop and sub-workflow blocks
    (`apps/daemon/src/workflows/nodes/*`).
  - Agent failover across accounts and agents, with usage thresholds
    (`apps/daemon/src/workflows/agent/{select,failover}.ts`).
  - Cron plus monthly presets with an IANA time zone (`packages/api/src/workflows/schedule.ts:109-120`).
  - Overlap policies `skip`/`queue`/`parallel`, missed-run grace with `skipped_missed` stubs, and
    run resume after a restart (`engine-resume.test.ts`).
  - Push notifications on failure (`apps/daemon/src/workflows/notifier.ts`), a write-only secrets
    store, MCP authoring tools, and a phone-friendly editor.
- **Git-event triggers that need no public URL.** `ls-remote` and REST polling with ETags,
  baselining, transition-keyed dedupe and coalescing (`apps/daemon/src/workflows/triggers/git-*.ts`).
  These work behind NAT. T3's GitHub automation requires a T3 Connect tunnel for its webhook URL.
- **No phone-home.** T3 sends product events (`ingest.t3.codes` → PostHog) and relay traces to Axiom
  by default, with opt-out through `T3CODE_TELEMETRY_ENABLED=false` (`docs/user/telemetry.md`).
  Orquester sends nothing. Keep it that way. If observability export is added, make it opt-in
  OTLP to the user's own receiver only.
- **Fleet deploy tooling.** `./deploy.sh` provides multi-target deploys with a per-target summary,
  a refusal to deploy unpushed or dirty trees, a post-deploy **headless browser smoke test with
  legacy localStorage fixtures**, a native-module guard before restart, Caddyfile drift notes,
  and a `rotate-password` that proves the hash changed (`deploy.sh:47-66,93-101,126-176`). T3's
  equivalent targets a single host.
- **Sessions survive restarts and deploys** through tmux and `KillMode=process`
  (`deploy/orquester.service`), and the agent host hands over across daemon restarts
  (`apps/daemon/src/agent-chat/supervisor.ts`). T3 interrupts running work on update and then
  resumes threads that support it (`docs/user/updating.md` §Before you update).
- **Host status includes listening ports and a guarded process kill** (`apps/daemon/src/system-status.ts`).
  T3's Live Processes view covers its own child tree, and its native monitor does not support WSL
  backends.
- **Hardened systemd unit**: `ProtectSystem=strict` with explicit carve-outs, `ProtectHome`, and an
  unprivileged user. T3's user service runs with the user's full rights, which is the intended
  trade-off for a laptop tool.
