# `apps/daemon/src/agent-host` — module map

The agent host is a **separate long-lived Node process**, not part of the daemon. It hosts the
four adapters, owns every provider child process, owns the per-thread event logs, and serves a
small HTTP-over-unix-socket API at `<appdir>/daemon/agent-host.sock`.

Why separate: `deploy/orquester.service` uses `KillMode=process`, so on restart only the node
process is signalled and anything parented to the tmux server survives. Keeping adapters in the
daemon would kill every in-flight turn on each deploy. The host runs in a tmux service session
(`orqsvc-agent-host`) exactly as cliproxy does.

Spec: `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md`. Every section reference below
(`§n`) is to that file.

## Directory map

| Path | Owner | Seam it implements |
|---|---|---|
| `adapter.ts` | **F** | `AgentAdapter` (§4.1) — operations, capabilities, and the interface rules as doc comments; `AdapterContext`, `AdapterFactory`, `Clock`, `IdGen`. |
| `services.ts` | **F** | The internal service interfaces the host packages code against: `ThreadStore`, `Ingestion`, `CheckpointService`, `LivenessRegistry`, `ProviderSnapshotRegistry`. |
| `host-protocol.ts` | **F** | `AGENT_HOST_PROTOCOL_VERSION`, socket/token path helpers, the daemon↔host route table, the auth header, `newHostInstanceId()`. Imported by **both** sides. Note `setThreadIdentity` (`POST /threads/:id/identity`): §3.4's account switch arrives here **already resolved** — the daemon owns the client-facing `POST /api/sessions/:id/account` because only it can apply the family and seeded-account gates and recompose the launch env. |
| `adapters/index.ts` | **F** | The static `id → AdapterFactory` registry. Imports are static by rule (§8: no lazy `import()` under the host). |
| `support/**` | **F** | Implemented, tested, dependency-free helpers every other package uses on day one. |
| `main.ts`, `server/**`, `orchestration/**` | **W1** | The host process entry, its unix-socket HTTP server, the readiness gate, the per-thread command lock, the §3.3 reconcile, the §3.4 session-restart policy. |
| `orchestration/provider-snapshots.ts` | **W1** | The §3.2 snapshot registry: the pending seed, the correlated on-disk cache, `startBootRefresh()`, the watcher-gated 5-minute top-up — **and the per-read bin-identity check**, one `realpath` + `stat` of the resolved bin (rate-limited per adapter) that kicks one background refresh when the CLI moved under the host. Nothing here ever spawns the CLI to decide that. |
| `store/**` | **W2** | `ThreadStore` (§5.1): the NDJSON logs, the atomic head, the **provider-session binding** (`binding.ts` — the resume cursor's durable home, merged field-wise), the receipts ring, attachments. Also the shared fold implementations in `@orquester/api`'s `agent-chat` module. |
| `ingestion/**` | **W3** | `Ingestion` (§5.1 rules, §5.6 batching/coalescing/slimming). The runtime→domain hop. |
| `checkpoints/**` | **W4** | `CheckpointService` (§5.4, §5.5): the hidden per-turn git refs, the diff read, revert pruning. |
| `adapters/claude/**` | **W6** | The Claude adapter (§4.5 Claude) + `apps/daemon/test/fixtures/claude/**`. |
| `adapters/codex/**` | **W7** | The Codex adapter (§4.5 Codex); `_generated/**` comes from **X2**. |
| `adapters/opencode/**` | **W8** | The OpenCode adapter (§4.5 OpenCode). |
| `adapters/grok/**` | **W9** | The Grok adapter + the ACP client (§4.5 Grok); `acp/_generated/**` comes from **X4**. |

The daemon-side half — proxying `/api/sessions/:id/*` onto the socket, spawning and adopting the
host, the kill guard, the tab records — is **W10** and lives in `apps/daemon/src/agent-chat/**`,
not here.

## `support/` — what is already implemented

Tests sit beside each file as `*.test.ts` and run through `pnpm --filter @orquester/daemon test`.

| File | What it gives you |
|---|---|
| `spawn.ts` | `spawnProviderChild()` — an **explicit** env (never a spread of `process.env`), all three stdio piped, a recorded pid, an `exited` promise that never rejects, and `kill()` escalating SIGTERM→SIGKILL on a grace deadline, signalling the whole **process group** for a `detached` child. Plus `exitOutcome()`, the §3.1 exit rule in one place. |
| `env.ts` | `buildProviderEnv()` per §3.1 "Launch environment": session PATH, `TMPDIR`, `HOME`, `ORQUESTER_SESSION_ID`, the per-adapter account-home variable (`ACCOUNT_HOME_ENV_VAR`), and extra launcher env — with ambient vendor credentials stripped unless explicitly allowed. `needsShellExpansion()` is the assertion that a value is already absolute. |
| `stderr.ts` | `StderrCapture` — line split with a carried remainder, ANSI strip, classification (drop / warning / error) and the §3.1 **redaction** (home paths → `~`, `Authorization`/`x-api-key` values, `Bearer`, `sk-`/`ghp_`/`xox*` shapes), plus a bounded 4 KiB rolling tail that only ever holds redacted text. |
| `deadline.ts` | `withDeadline()` and `DeadlineExceededError`, plus `AGENT_HOST_DEADLINES` and `TURN_LIVENESS_WINDOWS` — every bounded window §3.1 and §4.5 name, in one object. |
| `ndjson.ts` | `NdjsonLineReader` (partial chunks, `\r\n`, BOM), `parseNdjsonLine()` (skips blanks and `:` comments) and `NdjsonWriter`, a backpressure-aware writer that queues on `drain` and **drops** past its budget rather than growing host memory. |

Two deliberate non-`unref` decisions, both load-bearing and both covered by tests: the deadline
timer and the child process handle are **ref'd**, because `onTimeout` is what kills a wedged
child and the exit watcher is what settles the in-flight turn. A timer the loop is free to skip
would let the host exit with a child still running.

## Rules that apply to everything under this directory

- **No lazy dynamic `import()`** (§8). A host that survives a deploy runs old code until the
  drain-restart; loading changed source into it is a correctness bug, not a nicety.
- **Every step that waits on a child has a deadline** (§3.1), and an expired deadline kills the
  child rather than leaving the thread `starting` forever.
- **A running state never outlives its process** (§3.1/§4.1). Before `session.exited` the adapter
  settles the turn, closes every live task `stopped`, and fails every parked request.
- **An unknown frame is surfaced, never dropped by a catch-all** (§10): a `satisfies never` at
  compile time, a `runtime.warning` at run time — which never ends an active turn.
- **Wait on receipts and drains, never on sleeps** (§9). `ThreadStore.drain()` and
  `Ingestion.drain()` exist for exactly that.
- `raw.ndjson` is **as sensitive as the repository** (§10): it records whatever the agent read.
  Redact before anything leaves the host.
- **An identity change writes `launch.json` before the head, and starts nothing** (§3.4).
  `buildEnv`/`resolveHome` in `main.ts` read the live launch config, so the order is what makes the
  next session start pick the new account up; the restart itself is the ordinary ensure step on the
  next `/turn`. `orchestrator.setIdentity` refuses unless the thread is idle, refuses OpenCode, and
  refuses any move across the cliproxy boundary.
