# Automated workflows — an n8n-like automation engine for agents, scripts and git events

Status: design approved by the owner on 2026-09-28, section by section (approach A; data model;
engine with the revised usage-limit failover; triggers; UI with the phone addendum; API, MCP,
testing and build order). This document is the written spec awaiting the owner's review.

Research inputs (2026-09-28): the codebase map of the right rail, the agent-chat session lifecycle
as the Orquester MCP drives it, managed accounts and usage, projects/cloning/git providers, the
saved-prompts service pattern; and external research on stablyai/orca automations, n8n's model,
React node-editor libraries, cron libraries, sandboxing user JavaScript and git polling.

## 1. Problem and goal

Orquester runs coding agents interactively. The owner wants them to run **unattended, on a
trigger, chained with scripts**: "every 15 minutes read new Jira tickets; if there are any, have
Claude fix them, then mark them done", "on a new release tag, have Codex review and deploy",
"read new negative Play Store reviews, have Codex fix the bugs, build the AAB, have a cheap model
write structured JSON replies, then post them". Nothing in Orquester starts work by itself today.

The goal is a third right-rail section, **Automated workflows**: daemon-owned workflows edited in a
professional node editor (desktop and phone), triggered by schedules, git events or by hand, whose
blocks start agent sessions (with automatic account selection and cross-account / cross-agent
failover), run JavaScript, shell commands and HTTP requests, branch on success/failure and on
conditions, and show their live progress on the canvas. Agents are driven fully autonomously —
full access, plan mode off, never waiting on a human. Workflows are also creatable and editable
through the Orquester MCP, so an agent can build one from a description.

### 1.1 Requirements (the owner's list)

1. Triggers: every N minutes/hours, a daily time, chosen weekdays, monthly, cron; git events — a
   push to a branch, a new tag, a release, a pull request opened/updated/merged/closed.
2. A full node-based editor like n8n.
3. An agent block starts a new agent session in a project with a custom prompt or a saved prompt,
   both with the saved-prompt `{variables}`.
4. Pick the agent, model and effort; pick the account automatically by usage (least used; soonest
   reset with 5h/weekly thresholds — e.g. skip an account at 90% weekly when the threshold is 85%;
   a fixed account with fallbacks).
5. An ordered, editable fallback chain across agents (e.g. codex → grok → claude); the workflow
   fails only when every account of every agent in the chain is burnt. Always full access, plan
   mode off.
6. The agent's last message is a block output other blocks consume.
7. Programmable JavaScript blocks.
8. Every block ends in success or failure and the workflow branches on it.
9. An excellent, customizable editor: zoom, controls, the works.
10. Agents never ask the user anything and never pause.
11. Live progress of a running workflow on the canvas.
12. A workflow targets a project: an existing one in any workspace, or a temporary one (empty or
    cloned) deleted when the run ends.
13. (added) MCP tools to create and edit workflows.
14. (added) The design must look very good and be 100% functional on phones.

### 1.2 Owner decisions taken in brainstorming

| Question | Decision |
|---|---|
| Where the engine runs | Approach A: in the daemon, state persisted to disk, runs resume after a daemon restart |
| Agent sessions a workflow starts | A visible chat tab in the target project with a **Workflow** badge; kept after the run, auto-closed after N days (default 7), immediately with a deleted temp project |
| Credentials for scripts | Both: a write-only workflow secrets store, and scripts may read project files (`.env`) themselves |
| A trigger fires while the previous run is active | Per-workflow setting, default **skip**; also *queue one* and *parallel (max N)* |
| Git event detection | **Polling only** (`git ls-remote` + REST with ETags); no public webhook endpoint |
| Temporary project cleanup | Delete on success; on failure keep for N days (default 3), then auto-delete; "Delete now" in the run view |
| Notifications | On failure by default (push + Attention Center + toast); per-workflow toggles for success/off |
| Blocks in v1 | Trigger, Agent, Code (JS), Shell, HTTP, IF, Switch, Merge, Stop, Wait, Run workflow, Sticky note |
| Autonomy note | No "end with a summary" clause — output format is left to the prompt (JSON-only answers must work) |
| Limits | Raised (§5.9) |
| Usage limit mid-run | Must never stop the workflow while any eligible account/agent remains; same-agent failover **keeps the session** via the account switch (§5.4) |

### 1.3 Out of scope for v1

Loops/cycles in the graph (use a sub-workflow or an agent that loops itself); n8n's multi-item
"paired items" model; webhooks; a public webhook trigger; credentials types beyond secrets and the
existing git/agent accounts; OpenCode account selection (it has no accounts — it may still be a
chain entry, with no account policy); Python code blocks.

## 2. Architecture

```
packages/api/src/workflows/        wire types, per-block zod schemas, expression parser/renderer,
                                   graph validation, patch ops, step outline (shared: daemon, UI, MCP)
packages/api/src/prompt-variables.ts  the {variables} resolver moved out of the UI (§5.3)
packages/config                    paths + zod schemas: workflows.json, workflow-state.json,
                                   workflow-secrets.json (0600), workflow-runs/
apps/daemon/src/workflows/
  service.ts        definitions CRUD, tolerant load, revisions, broadcast on channel "workflows"
  secrets.ts        the secrets store (names out, values never)
  engine.ts         run queue, overlap policy, graph walk, persistence, resume, cancel, retry
  run-store.ts      runs/<runId>/run.json + events.ndjson + node logs; retention
  expressions.ts    rendering {{…}} against a run's context (pure parser lives in packages/api)
  nodes/            agent.ts code.ts shell.ts http.ts flow.ts wait.ts subworkflow.ts
  agent/            select.ts (account policy) failover.ts (limit loop) watch.ts (done + auto-answer)
                    classify.ts (usage_limit / auth) cooldowns.ts
  sandbox/          runner.mjs (JS host), spawn.ts (detached, file-based IO), redact.ts
  triggers/         scheduler.ts (croner, nextRunAt, missed-run grace), git-poller.ts
  projects.ts       temp project create/clone(+ref)/cleanup, tab auto-close sweeper
apps/daemon/src/mcp/tools/workflows.ts   MCP tools, through DaemonApi only
packages/ui/src/components/workflows/    rail panel, editor tab, canvas, steps view, inspectors,
                                         run view, secrets, templates
packages/ui/src/lib/workflows/           store (module zustand, like saved prompts), API client,
                                         undo history, clipboard, layout (dagre), run overlay
```

**Driving agents.** The engine reaches agent sessions **only through the daemon's own REST API**,
in-process, exactly as the MCP does: an `InjectDaemonApi` bound to the always-on unix-socket app
(`authRequired:false`, `mode:"local"`; the HTTP app is hot-reloadable so a reference to it goes
stale). So every gate the GUI has — family gate, seeded-account gate, claudex model gate,
tab-then-thread order, `HOST_UNAVAILABLE` — applies to workflows by construction. The unix app is
built after the services, so it is handed to the engine late (`workflows.attachApi(api)`). The
MCP helpers the engine reuses (`sendCommand`, `readThread`, `turnBaseline`, `waitForTurn`,
`watchSessions`, `assistantTextForTurn`, `latestSettledTurn`, the agent/model/account resolvers in
`mcp/agents.ts`) move to a shared `apps/daemon/src/chat-client/` module both import, keeping the
MCP invariant (tools never touch services) for the engine as well.

**Wiring in `startDaemon`.** Construct `WorkflowSecrets`, `WorkflowService`, `RunStore` after
saved prompts (`await load()`); bridge their lifecycle to the Broadcaster; after `agentChat.init()`
attach the API, then `engine.resume()` (§5.8), then start the scheduler and git poller. `stop()`
stops the scheduler, poller and sweepers first, flushes the write chains, and does NOT kill
sandbox children (they are detached and survive; §5.8). Stop must stay fast (3 s backstop).

**New dependencies.** UI: `@xyflow/react` (MIT, v12; no eval/Function/WASM, checked), `@dagrejs/dagre`
(MIT), `cronstrue` (MIT). Daemon + UI: `croner` (MIT, zero-dep, ESM, IANA time zones). No native
addon. React Flow's CSS is imported and its colour variables are re-pointed at the theme's
`--n-*` / semantic variables — never hex.

## 3. Data model

### 3.1 Workflow definition

Stored in `<appdir>/daemon/workflows.json` as `{version:1, workflows:[…], …extra}`, parsed
entry-wise tolerantly exactly like `saved-prompts.json` (records `.passthrough()`; an unreadable
entry or unknown top-level key written back verbatim; a corrupt/unknown-version file moved aside
as `.corrupt-<stamp>`, never overwritten; an unreadable file blocks mutations with 503
`WORKFLOWS_UNAVAILABLE`). Atomic writes, 0600. Limits: ≤ 500 workflows, ≤ 200 nodes and ≤ 400
edges per workflow, a definition ≤ 2 MiB serialized.

```ts
interface Workflow {
  id: string;                         // uuid
  name: string;                       // 1..120
  description?: string;
  enabled: boolean;                   // false = triggers paused; manual runs still allowed
  revision: number;                   // +1 on every save; a stale PUT/patch → 409 REVISION_CONFLICT
  project: WorkflowProject;
  settings: WorkflowSettings;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  pinned?: Record<string /*nodeId*/, unknown>;  // pinned outputs for test runs (§7.6), ≤ 1 MiB each
  createdAt: string; updatedAt: string;
}
type WorkflowProject =
  | { kind: "existing"; projectPath: string }            // <workspacesDir>/<ws>/<project>
  | { kind: "temp"; workspace: string;                   // that workspace's git account clones
      source: { kind: "empty" } | { kind: "clone"; url: string; ref?: string } };
interface WorkflowSettings {
  overlap: "skip" | "queue" | "parallel";  // default "skip"; queue holds at most ONE pending fire
  maxConcurrent: number;                   // parallel only; 1..8, default 2
  timezone: string;                        // IANA; default = the creating browser's zone
  runTimeoutMinutes?: number;              // whole-run cap, default none
  notify: { onFailure: boolean; onSuccess: boolean };  // default {true,false}
  keepFailedTempDays: number;              // default 3, 0..30
}
interface WorkflowNode {
  id: string;                              // uuid, stable; edges key on it
  type: NodeType;
  name: string;                            // unique in the workflow; [A-Za-z][A-Za-z0-9_]{0,39}
  position: { x: number; y: number };
  config: NodeConfig;                      // per-type zod schema (§4)
  disabled?: boolean;                      // a disabled block passes its input through as success
  notes?: string;
  retry?: { maxTries: number /*1..10*/; delaySeconds: number /*0..3600*/ };
  timeoutMinutes?: number;                 // per-type default and maximum (§5.9)
  projectOverride?: string;                // run this block in another existing project
}
interface WorkflowEdge {
  id: string; source: string; target: string;
  sourceHandle: "success" | "error" | "true" | "false" | `case:${number}` | "default";
}
```

Node names — not ids — appear in expressions (`{{nodes.Review.output.text}}`) because they are
readable; a rename rewrites every reference in the workflow atomically (UI and MCP
`rename_node`), and validation flags a reference to an unknown name.

Runtime state that changes without an edit — each schedule trigger's `nextRunAt`/`lastFiredAt`,
each git trigger's cursor (seen refs, ETags, dedup keys), the account cooldowns — lives in a
separate `workflow-state.json`, so a scheduler tick never races an editor save.

### 3.2 Outputs and the run context

Every block produces `{status, output?, error?}`; `output` is one JSON value (no item arrays).

| Block | `output` |
|---|---|
| trigger.* | the event (§6): `{kind:"manual", input}`, `{kind:"schedule", firedAt, scheduledFor}`, `{kind:"git", …}` |
| agent | `{text, sessionId, agent, model, accountId, durationMs, hops:[…]}` |
| code | the script's return value |
| shell | `{stdout, stderr, exitCode}` (stdout/stderr = the tail within the output cap) |
| http | `{status, headers, body}` — `body` parsed as JSON when the response is JSON |
| if / switch / wait | their input, passed through |
| merge | `{[nodeName]: output}` for every branch that arrived |
| workflow | the child run's final output (the output of its last succeeded block, or its Stop value) |
| stop | ends the run; its configured value becomes the run's final output |

The run context an expression reads: `nodes.<Name>.output|status|error`, `input` (the output of
the block's single live upstream, or the merge object), `trigger`, `run {id, startedAt,
workflowId, workflowName, attempt}`, `project {path, name, workspace, branch}`, `secrets.<NAME>`.

### 3.3 Expressions

`{{ path | filter }}` in any text field. The grammar is a hand-written parser in
`packages/api/src/workflows/expressions.ts` — **no eval, no Function, anywhere** (the production
CSP forbids it in the browser, and the daemon should never evaluate user text as code outside the
sandbox): a path is `root(.ident | [index] | ["key"])*`; filters are `json` (pretty JSON),
`compact` (one-line JSON), `default("x")`, `trim`, `lines(n)` (first n lines), `first`, `last`,
`length`, `upper`, `lower`. A non-string value renders as pretty JSON. A missing path renders as an
empty string and records a warning on the block; with `| default(...)` it takes the default. `\{{`
escapes a literal. Parsing errors are validation errors, shown on the block.

Saved-prompt `{variables}` (`{project}`, `{branch}`, `{diff}`, …) keep their single-brace syntax in
agent prompts and are rendered daemon-side at run time (§5.3). `{{…}}` renders first, then
`{variables}` — and a value inserted by `{{…}}` is escaped for the variables pass
(`escapePromptVariables`), so text from a trigger can never inject a `{diff}`.

**Secrets in expressions.** `{{secrets.X}}` is allowed in HTTP headers/URL/body, shell env
mappings, and code blocks (`secrets` argument). In an agent prompt it is allowed but the editor
shows a warning ("this secret will be written to the agent's transcript"). Every persisted run
artifact is redacted (§5.7).

### 3.4 Execution semantics

- The graph must be a DAG (validation refuses cycles). Triggers have no inputs; every other block
  has one input handle that accepts any number of edges.
- A run starts at the trigger that fired (manual runs start at a `trigger.manual` if present,
  else at every trigger node, which output the manual input). Other triggers are marked skipped.
- **Readiness:** a block runs once every incoming edge is settled — *live* (its source finished and
  took that handle) or *dead* (its source was skipped, or finished on another handle) — and at
  least one is live. All dead → the block is **skipped**, and its outgoing edges are dead
  (dead-path elimination). A block with several live inputs and no Merge sees `input` = the merge
  object; Merge makes that explicit and adds a mode: *wait for all live* (default) or *first
  arrival* (the later ones are ignored).
- Independent branches run concurrently (a global cap of 4 concurrently executing agent blocks
  and 8 sandbox processes, queueing beyond).
- **Failure:** a failed block retries per `retry`. Then, if its `error` handle has an edge, the run
  continues down it (the block's status is `failed`, the run keeps going); otherwise the run
  **fails** — running branches are cancelled (agents interrupted, processes killed) and the run
  ends `failed`.
- A usage limit is never a block failure while the chain has candidates (§5.4); a limit therefore
  never spends a retry.
- **Run outcomes:** `succeeded`, `stopped` (a Stop block / `stop()`; counts as success for
  notifications unless the Stop is configured `as: "failure"`), `failed`, `cancelled` (user),
  `skipped` (overlap: `skipped_overlap`; missed schedule: `skipped_missed`), `interrupted` (only if
  a resume is impossible, §5.8).
- Block states: `pending`, `queued`, `running`, `waiting` (Wait block / wait-for-reset),
  `succeeded`, `failed`, `skipped`, `cancelled`.

## 4. Block catalogue (config schemas)

All configs are zod schemas in `packages/api/src/workflows/nodes.ts`, exported with a JSON-schema
rendering and one example each (served to the MCP, §8).

- **trigger.manual** `{ inputSchemaHint?: string }` — a JSON example shown in "Run now".
- **trigger.schedule** `{ preset: SchedulePreset, cron: string }` where `SchedulePreset` is one of
  `{kind:"minutes", every}` (1..59), `{kind:"hours", every, atMinute}`, `{kind:"daily", time}`,
  `{kind:"weekly", days:[0..6], time}`, `{kind:"monthly", day:1..31, time}`, `{kind:"cron"}`. The
  cron is derived from the preset (5 fields; 6 with seconds only for `kind:"cron"`) and is the
  authority; the preset lets the editor reopen as the user built it. Minimum interval 1 minute.
- **trigger.git** `{ repo: {kind:"project"} | {kind:"url", url, accountId?}, event }` — §6.2.
- **agent** — §5.1.
- **code** `{ source: string /*≤ 512 KiB*/, timeoutMinutes?, memoryMb? /*256..16384, default 4096*/ }`.
- **shell** `{ script: string, shell: "bash" | "sh", env: {name, value}[], timeoutMinutes? }` —
  `{{…}}` is **refused inside `script`** (validation error with the fix); values reach the script
  only through `env` (whose values may use `{{…}}` and secrets). Exit code 0 = success.
- **http** `{ method, url, headers: {name,value}[], query: {name,value}[], body?: {kind:"json"|"text"|"form", value}, timeoutSeconds?, successStatuses: "2xx" | number[], followRedirects }`.
- **if** `{ combine: "all" | "any", rules: Rule[] }` where `Rule = {left: string /*expression*/,
  op, right?: string}`, `op` ∈ `equals`, `notEquals`, `contains`, `notContains`, `startsWith`,
  `endsWith`, `matches` (RE2-safe subset: a regex compiled with a 100 ms guard on a ≤ 1 MiB
  input), `gt`, `gte`, `lt`, `lte` (numeric), `isEmpty`, `isNotEmpty`, `exists`, `isTrue`,
  `isFalse`. Outputs `true` / `false`.
- **switch** `{ cases: {label, rules, combine}[], fallback: boolean }` — first matching case wins;
  outputs `case:<n>` and `default`.
- **merge** `{ mode: "all" | "first" }`.
- **stop** `{ as: "success" | "failure", message?: string, value?: string /*expression*/ }`.
- **wait** `{ kind: "duration", minutes } | { kind: "until", time: "HH:MM", timezone? }` — ≤ 7 days.
- **workflow** `{ workflowId, input?: string /*expression*/, waitForCompletion: true }` — depth ≤ 5,
  cycles refused at validation and at run time; the child run is linked both ways.
- **note** `{ text, color }` — a sticky note; never executes, never connects.

## 5. The engine

### 5.1 Agent block

```ts
interface AgentBlockConfig {
  prompt: { kind: "text"; text: string } | { kind: "saved"; promptId: string; append?: string };
  session: { kind: "new"; title?: string } | { kind: "continue"; fromNode: string };
  chain: ChainEntry[];                     // ≥ 1; order = fallback order across agents
  autonomyNote: boolean;                   // default true
  whenOnlyWatchLoopsRemain: "finish" | "wait";   // default "finish" (e.g. a dev server left running)
  whenAllBurnt: { kind: "fail" } | { kind: "wait-for-reset"; maxWaitHours: number };  // default fail
  maxMinutes: number;                      // default 240, ≤ 1440
}
interface ChainEntry {
  agent: string;                           // registry refId: claude | claudex | claudemix | codex | grok | opencode
  model: string;
  options?: { id: string; value: string | boolean }[];   // effort etc., per the model's descriptors
  accounts: AccountPolicy;                 // ignored for opencode (no accounts)
}
interface AccountPolicy {
  strategy: "least-used" | "soonest-reset" | "fixed";
  accounts?: string[];                     // fixed: try in this order; others: allow-list; omitted = all of the family
  includeSystem: boolean;                  // the daemon user's own login as a candidate; default false
  maxSessionPct?: number;                  // the 5h window
  maxWeeklyPct?: number;
  scoped?: { label: string; maxPct: number; onlyForModels?: string[] }[];   // e.g. Claude's "Fable"
  soonestResetWindow?: "weekly" | "session";  // soonest-reset only; default weekly
  leastUsedMetric?: "max" | "weekly" | "session";  // least-used only; default max
  unknownUsage: "last" | "exclude";        // default "last"
}
```

`session.kind:"continue"` sends this block's prompt as a follow-up turn into the session another
agent block created in the same run (validation: `fromNode` must be an upstream agent block); it
uses that session's agent/account (its chain is ignored except for failover, which uses the chain
of the block that created the session).

**Run steps**

1. **Select** (§5.2) → `{agent, model, options, accountId}` or "all burnt".
2. **Create** `POST /api/sessions {kind:"agent-chat", refId, projectPath, cwd, title, accountId
   (always explicit, "system" included), model (claudex/claudemix only), chat:{accountId,
   modelSelection, runtimeMode:"full-access"}, owner:{kind:"workflow", workflowId, runId, nodeId}}`.
   The model is validated against the provider catalogue before creating (the host only
   shape-checks). The family is re-checked by the engine (create silently degrades a wrong-family
   id to the system login).
3. **Send** `POST …/turn {commandId, input, interactionMode:"default"}` — plan mode is per turn and
   always `default`; OpenCode's `agent` option is never set. The input is the rendered prompt
   (§5.3), followed, when `autonomyNote`, by: *"You are running unattended inside an automated
   workflow. No human will answer. Never ask questions or wait for confirmation; make reasonable
   decisions and complete the task fully."*
4. **Watch** (§5.5) until done, a failure, a limit (§5.4), `maxMinutes`, or the run is cancelled.
5. **Output**: after the session is fully settled, the thread is re-read and `text` is the parent's
   final assistant text of the latest settled turn (`assistantTextForTurn`, re-emitted Claude
   copies dropped, commentary excluded unless it is all there is), uncapped by the MCP's 16 KiB view
   cap and capped at 2 MiB. Read BEFORE any tab close (a close deletes the thread).

### 5.2 Account selection

For each chain entry, in order:

1. Family = `proxyAccountFamily(refId) ?? refId`; OpenCode and claudex router/xAI models have no
   account → the entry is a single candidate with `accountId:"system"`, eligible unless in cooldown.
2. Candidates = the family's managed accounts (`agentAccounts.list()`), plus `system` when
   `includeSystem`; for claudex/claudemix only seeded accounts; intersect with `accounts` if given.
3. Drop: `needsReauth`; in cooldown (§5.4); over any threshold. Windows are read from
   `usage.snapshot()` (in memory, no I/O), joined **by account id** (`system` → `.system`, or the
   family head when there are no managed accounts); every window goes through `currentWindow`
   (expired windows are ignored — the Codex fallback keeps stale ones); `percent ≥ 100` is always
   burnt; Grok has no 5h window, so a session threshold is vacuous there, not "unknown"; a scoped
   threshold applies only to models in `onlyForModels` when set. No reading, `available:false`, or a
   reading older than 20 min = *unknown* → tried last (`unknownUsage:"last"`) or dropped.
4. Rank: **least-used** by the chosen metric ascending (ties: soonest weekly reset, then label);
   **soonest-reset** by the chosen window's `resetsAt` ascending (the owner's example:
   therealeduard465 weekly 90% ≥ 85 is dropped; jasperclaude 63% resets in 4d wins over accounts
   resetting later); **fixed** by the `accounts` order.
5. First ranked candidate wins. None → next chain entry.

Every decision is recorded on the block as `selection: {chosen, reason, usageAsOf, skipped:[{agent,
accountId, label, why:"needsReauth"|"notSeeded"|"threshold"|"cooldown"|"unknownUsage"|"catalog",
detail}]}` — e.g. `"therealeduard465: weekly 90% ≥ 85%"`. `POST /api/workflows/account-preview`
runs the same function for the editor's "Who would run now?".

### 5.3 Rendering prompts

`packages/api/src/prompt-variables.ts` receives the resolver moved from
`packages/ui/src/lib/saved-prompts/variables.ts` (`resolvePromptVariables(body, source)` plus the
pure formatters), with an injected source `{gitStatus, gitWorkingDiff, now, timeZone, agentLabel,
modelLabel}`. The UI keeps its `ApiClient`-backed source (behaviour unchanged, its tests kept); the
daemon source calls `GitService.status/workingDiff` on the realpath'd project and formats
`{date}`/`{time}` with `Intl.DateTimeFormat` in the **workflow's time zone** (the daemon process
zone is not the user's). A failed git read fails the block with the variable named (the UI's
"insert nothing on failure" becomes "do not send a prompt missing its variables").

### 5.4 Usage limits and auth failures: the failover loop

The invariant: **a usage limit or an auth failure never fails an agent block while any eligible
candidate remains in its chain.**

**Detection is structured, never a string match.** `RuntimeErrorPayload` and
`RuntimeWarningPayload` (`@orquester/api` agent-chat) gain optional `reason?: "usage_limit" |
"auth"` and `resetsAt?: string`, set by each adapter where it already branches:

| Adapter | usage_limit | auth |
|---|---|---|
| Claude | the parked-turn warning (`rate_limit_event`, `isRateLimitBlocking` → `status:"rejected"`, `resetsAt` from `rate_limit_info.resetsAt`), and a failed result with `latestAssistantRateLimited` / rejected limit types | `error:"authentication_failed"`, `api_error_status` 401/403 |
| Codex | `codexErrorInfo` `usageLimitExceeded` / `rateLimitExceeded` / `sessionBudgetExceeded` (a `willRetry` error is not acted on until the retry fails) | `unauthorized` |
| Grok | `stopReason:"rate_limit"` | the CLI's not-logged-in failure |
| OpenCode | provider 429 classes where the SDK reports them | 401 |

Ingestion carries both fields into the `runtime.error` / `runtime.warning` activity payloads; the
engine reads them off the thread (activities after the block's baseline). Replay tests feed each
adapter's recorded limit frames through the classifier. A daemon or host from before the field
simply produces no reason, and the engine falls back to a documented, tested set of legacy message
prefixes ("Claude usage limit reached.", "Grok usage limit reached.") — only for that case.

**The loop** (per agent block; at most 12 hops; each account at most once unless its cooldown
expired meanwhile):

1. **Cool down** the account: until `resetsAt`; else the reset of the account's burnt window from
   the usage snapshot; else 1 h. Cooldowns persist in `workflow-state.json` and are shared by every
   workflow. An auth failure marks the account unusable for the run and cools it 1 h.
2. **Stop the work cleanly**: `POST …/interrupt {commandId}` without a `turnId` (stops the turn and
   live background subagents/shells — they run on the same exhausted account); wait until the
   session reads idle: no active turn, no pending request, no queued turn, no background liveness
   (the conditions of `identitySwitchRefusal`). Pending requests are cancelled by the interrupt.
3. **Next candidate of the SAME agent family** (same registry entry): `POST
   /api/sessions/:id/account {commandId, accountId}` — the existing composer account switch,
   which re-points the thread and resumes the provider session on the next message, transcript
   intact. Then send: *"You were interrupted by a usage limit and have been moved to another
   account. Continue the task from exactly where you stopped."* (plus the autonomy note). Not
   possible for OpenCode, or when the switch is refused (the engine retries the idle wait once) —
   then treat as "no same-family candidate".
4. **No same-family candidate left**: the next chain entry in a **new session** (same project,
   same `owner`), with a handoff prompt: the original rendered prompt; *"A previous agent
   (<agent>) was cut off by a usage limit. Its partial work may already be in the working tree —
   inspect it and continue from there."*; the previous agent's last assistant messages (≤ 32 KiB);
   and `git status --short` of the project (≤ 8 KiB).
5. **Chain exhausted**: `whenAllBurnt:"fail"` → the block fails with `error.kind:"all_burnt"` and
   every hop and skip reason (the failure handle can route it); `"wait-for-reset"` → the block
   enters `waiting` until the earliest cooldown/reset among the chain's accounts (≤
   `maxWaitHours`), then resumes on that account — in the same session when it is the same family.
6. Every hop is recorded: `hops:[{agent, accountId, label, sessionId, startedAt, endedAt,
   reason:"usage_limit"|"auth", resetsAt}]` and shown on the block ("claude/therealeduard465 →
   usage limit (resets 22:40) → claude/jasperclaude → finished").

A limit that hits during selection or right at create is the same loop. A limit's hop does not
count against `retry`; a hop's time counts toward `maxMinutes` only while an agent is working (a
`wait-for-reset` wait does not).

### 5.5 Watching an agent: done detection and unattended operation

The watcher subscribes to the Broadcaster (`watchSessions`) and re-reads the session summary on
every event (10 s safety re-read). It acts on:

- **Questions** (`hasPendingUserInput`): answered via `POST …/answer`: for each question, if custom
  answers are allowed, *"No user is available. Choose the most reasonable option yourself and
  proceed autonomously."*; otherwise the option labelled "(Recommended)", else the first option.
  A message-mode question is answered the same way (the answer is a steer). Never `/dismiss`.
- **Approvals** (should not occur under full-access): `POST …/approval {decision:"accept"}`.
- **Plan card** (`plan-ready`, if the model calls ExitPlanMode anyway): send
  `buildPlanImplementationPrompt(plan)`, as `implement_plan` does.
- **Limits / auth** → §5.4.
- **Done** = the latest turn settled after the baseline AND `resolveChatActivity(summary).rung ===
  "completed"` (no background work, no continuing goal, nothing pending) — or rung `monitoring`
  (only watch loops, e.g. a dev server) when `whenOnlyWatchLoopsRemain:"finish"`, after a 60 s
  grace. A background agent finishing can wake the parent into a provider-started turn, so "done"
  is re-checked after a 5 s quiet window before the output is read.
- **Failed** = the latest turn settled `failed`/`interrupted` (not by us) or the session reads
  `error` with no limit/auth reason → an ordinary block failure (`error.kind:"agent_error"`, the
  host's `lastError` message).
- **Timeout** (`maxMinutes`) → interrupt, block fails `error.kind:"timeout"`.
- **Run cancelled** → interrupt; block `cancelled`.

### 5.6 Code and shell blocks: the sandbox

Each execution is a **detached** child (`setsid`, own process group) so it survives a daemon
restart, with file-based IO in `runs/<runId>/nodes/<nodeId>/<attempt>/`:

- `input.json` (0600): `{input, nodes, trigger, run, project, secrets}` — deleted when the attempt
  ends. Code gets it via the runner; shell gets only `env`.
- `stdout.log`, `stderr.log`: the child's fds point straight at the files (no pipes to break);
  each capped at 50 MiB (a watchdog truncates and appends a notice past the cap).
- `result.json` (code: the return value or the thrown error) and `exit.json` (`{code, signal,
  endedAt}`) — both written by `runner.mjs`, which supervises every attempt: for code it runs the
  user module in-process; for shell it spawns `bash`/`sh` as its child and waits. So an exit is
  recorded on disk even when the daemon is down, and a restarted daemon reads it (§5.8).
- `pid` + `/proc` starttime recorded at spawn (for resume, §5.8).

**Code.** `process.execPath --max-old-space-size=<memoryMb> runner.mjs <attemptDir>`; the runner
imports the user's source as an ES module from the attempt dir and calls its default export with
`{input, nodes, trigger, run, project, secrets, log, stop, require}` — `require` is
`createRequire(<project>/package.json)` so the project's npm packages work; `fetch` is global
(Node 20). `stop(reason?)` ends the run as `stopped`. A throw = failure (message + stack). The return
value must be JSON-serializable, ≤ 16 MiB. `console.log` → stdout.log.

**Shell.** `bash -c <script>` (or `sh`) with `env` values rendered (secrets allowed).

**Common:** cwd = the realpath'd project directory inside `fsRoot`; env built explicitly, never a
spread of the daemon's `process.env` (the `sessionEnvBase` rule: no `ORQUESTER_*` credentials):
`PATH=sessionPath()`, `HOME`, `TMPDIR=<appdir>/tmp`, `LANG`, `ORQUESTER_WORKFLOW_RUN_ID`,
`ORQUESTER_WORKFLOW_ID`, `ORQUESTER_AGENT_LAUNCH=<uuid>` (so Settings → System lists and can kill a
leftover), plus the block's env. Timeout (default 30 min, max 24 h): SIGTERM to the group, SIGKILL
after 5 s. The run's cancel kills the group the same way.

### 5.7 Secrets

`<appdir>/daemon/workflow-secrets.json`, 0600: `{version:1, global:{NAME:value},
workflows:{<id>:{NAME:value}}}`; names `[A-Z][A-Z0-9_]{0,63}`, values ≤ 64 KiB. A workflow's own
secret shadows a global one. The API returns names (and scope, updatedAt) only; `PUT` sets, `DELETE`
removes; values never cross the wire or reach a log. Deleting a workflow deletes its secrets.
**Redaction:** every value of every secret is replaced by `«secret:NAME»` in everything persisted or
broadcast — block outputs, errors, logs (redacted as they are tailed and before they are served),
run events. Values shorter than 4 characters are not redacted (noise) and the UI warns on such a
secret. Scripts may additionally read the project's own files (`.env`); that is the user's choice
and is not redacted.

### 5.8 Persistence and resume

`<appdir>/daemon/workflow-runs/<runId>/run.json` (atomic rewrite on every state change) holds the
run: the **frozen definition** it started with, trigger payload, status, per-block state (status,
attempt, output, error, timings, selection, hops, sessionId), and the `waitingOn` of every running
block:

- `{kind:"agent", sessionId, baseline, commandId, deadlineAt, phase}` — the commandId is minted and
  written BEFORE the POST, so a re-post after a crash is deduplicated by the host's receipts.
- `{kind:"process", pid, starttime, attemptDir, deadlineAt}`.
- `{kind:"timer", until}` (Wait, wait-for-reset, retry delay).
- `{kind:"child-run", runId}`.
- `{kind:"http", method, startedAt}`.

`events.ndjson` appends the run's progress (the run view and history read it). An index file
`workflow-runs/index.json` (rebuildable from the run dirs) lists runs per workflow for the panel.

**Resume** (`engine.resume()`, after `agentChat.init()`): for each run not finished —
agent: re-post the pending command if its receipt is unknown, then re-enter the watcher with the
persisted baseline (a turn that settled meanwhile resolves at once); process: alive (pid +
starttime match) → keep watching the files; dead → read `exit.json` (and `result.json`), else the attempt is
`interrupted` and the block's retry policy decides; timer: re-arm at the wall-clock `until`;
child-run: re-subscribe; http: a GET/HEAD is re-issued, anything else fails `interrupted`
(retryable). Deadlines are wall-clock, so a restart never extends them. A run whose state cannot be
read is marked `interrupted` with the reason.

**Retention:** the last 100 runs per workflow and nothing older than 30 days (a sweeper, hourly);
a running run is never swept. Deleting a workflow deletes its runs (and cancels running ones).

### 5.9 Limits

| What | Limit |
|---|---|
| Agent final message `text` | 2 MiB |
| Any block output passed downstream / code result | 16 MiB |
| stdout/stderr per code/shell attempt | 50 MiB each (UI tails; full download) |
| HTTP response body | 32 MiB |
| Code memory | default 4 GiB, 256 MiB..16 GiB per block |
| Code/shell timeout | default 30 min, ≤ 24 h |
| Agent `maxMinutes` | default 240, ≤ 1 440 |
| HTTP timeout | default 5 min, ≤ 1 h |
| Wait | ≤ 7 days |
| Whole run | optional `runTimeoutMinutes` |
| Concurrent runs | 4 (global); agent blocks 4, sandbox processes 8, queued beyond |
| Sub-workflow depth | 5 |

### 5.10 Projects, tabs and cleanup

- **Existing project:** the path must be `<workspacesDir>/<ws>/<project>` inside `fsRoot`
  (`resolveProject`); a missing project fails the run at start (`error.kind:"project_missing"`).
- **Temp project:** `POST /api/workspaces/<ws>/projects {name:"wf-<slug>-<runId8>", source}` —
  `empty`, or `clone` with the workspace's git account; `ref` (the workflow's or the git trigger's
  sha/branch/tag) is a new optional field on the clone path (`git clone` then `git checkout
  --detach <sha>` / `--branch <ref>`), and the clone gains a timeout and `GIT_TERMINAL_PROMPT=0`.
  The run's project is recorded; the sidebar shows it with a small "workflow" marker.
- **Cleanup:** a succeeded/stopped run deletes the temp project (`DELETE …/projects/:p`, which
  closes its tabs and deletes its saved prompts/todos); a failed/cancelled/interrupted run keeps it
  `keepFailedTempDays`, then the sweeper deletes it; "Delete now" in the run view.
- **Workflow tabs:** sessions carry `owner:{kind:"workflow", workflowId, runId, nodeId}` (new
  optional field on `CreateSessionRequest`, the chat create fields, `SessionSummary` and
  `sessionRecordSchema`; an older daemon drops it on rollback). Tabs show a **Workflow** chip
  linking to the run. A sweeper closes workflow tabs in existing projects `workflowTabRetentionDays`
  (global, default 7) after their run ended — never a tab the user sent a message in after the run
  (tracked via the thread's last user-message time vs the run's end).

### 5.11 Overlap, queue and notifications

On a fire: `skip` → if any run of the workflow is active, record a `skipped_overlap` run stub
(visible in history); `queue` → keep at most one pending fire, start it when the active run ends
(a further fire while one is pending is `skipped_overlap`); `parallel` → start unless
`maxConcurrent` runs are active (then skip). Manual runs obey the same policy but the UI offers
"run anyway".

Notifications: on a finished run per `settings.notify` — a Web Push (the existing push service,
debounced per workflow), an Attention Center entry (a new attention source "workflow run failed"
with a link to the run) and a toast in open clients.

## 6. Triggers

### 6.1 Schedule

`croner` computes `nextRun(cron, {timezone})` only; the engine owns one self-rescheduling
`setTimeout` (unref'd, re-armed at the earliest `nextRunAt` over all enabled schedule triggers, at
most 60 s ahead to absorb clock jumps). `nextRunAt`/`lastFiredAt` persist in `workflow-state.json`.
On boot and on each tick, a trigger whose `nextRunAt` passed fires once if within 15 minutes
(`missedRunGraceMinutes`), otherwise a `skipped_missed` stub is recorded and the next time is
computed — never a burst of catch-up runs. Editing or enabling recomputes from now. The editor
shows `cronstrue`'s English text and the next 5 fire times (computed client-side with croner — no
eval, checked — and confirmed by `GET /api/workflows/schedule-preview`).

### 6.2 Git events

```ts
interface GitTriggerConfig {
  repo: { kind: "project" } | { kind: "url"; url: string; accountId?: string };  // no account = public
  event:
    | { kind: "push"; branches: string[] }                // globs; [] = the default branch
    | { kind: "tag"; pattern?: string }                   // glob, e.g. "v*"
    | { kind: "release"; includePrereleases: boolean; includeDrafts: false }   // GitHub only
    | { kind: "pull_request"; actions: ("opened"|"updated"|"merged"|"closed")[]; baseBranches?: string[] };
}
```

- `repo.kind:"project"` resolves the workflow project's `origin` URL and its workspace's git
  account (a temp workflow's `clone` URL and workspace account).
- **One poller per repo key** (normalised URL + account), shared by every trigger watching it.
- **Branches and tags:** `git ls-remote --heads --tags <url>` every 60 s (± 10 % jitter) — any
  provider, no REST quota — through a new `AccountsService.lsRemote(accountId|null, url)` that
  mirrors `cloneRepo`'s transport (credential file for HTTPS, `GIT_SSH_COMMAND` with the account key
  and the pinned known_hosts), with a 30 s timeout and `GIT_TERMINAL_PROMPT=0`. Peeled `^{}` lines
  give an annotated tag's commit.
- **PRs and releases:** REST via new `GitProvider` methods `listPullRequests(creds, repo, since)`
  and `listReleases(creds, repo)` — GitHub (`/pulls?state=all&sort=updated&direction=desc`,
  `/releases`, with `If-None-Match` ETags: a 304 is free), Bitbucket Cloud
  (`/pullrequests?state=OPEN&state=MERGED&state=DECLINED&sort=-updated_on`; the UI warns when the
  token lacks `read:pullrequest`), Bitbucket Server/DC (`/pull-requests?state=ALL&order=NEWEST`).
  Every 120 s (Bitbucket Cloud 180 s). Releases are GitHub-only (the editor offers "tag" elsewhere).
  A PR's `updated` = its head sha changed; `merged` = GitHub `merged_at` set / Bitbucket `MERGED`.
- **Baseline:** a trigger's first successful poll only records the current state — creating or
  re-enabling a trigger never fires on existing refs.
- **Dedup:** fired keys (`push:<ref>:<sha>`, `tag:<name>:<sha>`, `release:<id>`,
  `pr:<n>:<action>:<headSha>`) persist per trigger (a ring of 1 000) — a restart never re-fires.
- **Coalescing:** several pushes to one branch between polls → one event with `previousSha..sha`;
  new tags → one run per tag, at most 10 per poll (the rest recorded as skipped).
- **Payload:** `{kind:"git", event, repo:{url, name}, ref, sha, previousSha?, branch?, tag?,
  release?:{id, name, tag, body, url, prerelease}, pr?:{number, title, body, url, author, head,
  base, action, headSha}}`.
- **Failures:** a poll error backs off exponentially (to 15 min) and shows on the trigger block
  ("last poll failed: auth rejected"); never fires anything.
- **Untrusted text:** branch names, tag names, PR titles/bodies and release notes are attacker-
  controllable. They reach shell only through `env` (never script text, §4) and HTTP/code as data;
  an agent prompt that references `trigger.pr.title|body` or `trigger.release.body` gets an editor
  warning about prompt injection.

### 6.3 Manual

"Run now" (UI, MCP) with an optional JSON input → `{{trigger.input}}`. Works when the workflow is
disabled. Test runs (§7.6) are manual runs flagged `test:true`, shown distinctly in history.

## 7. UI

### 7.1 Right-rail panel "Automated workflows"

Registered as the third `RightRailPanelId` (`"workflows"`; `isRightRailPanelId` accepts it; the
render check's `FAKES` gets an entry), lucide `Workflow` icon, title "Automated workflows",
short title "Workflows". It follows the dock contract (root `flex min-h-0 flex-1 flex-col`, own
scroll region, `px-3`, state that must survive a panel switch in the workflows module store).

- Header: `RailSearchInput`, a **New workflow** button, `RailSegmented` filter *All · This project
  · Running*.
- A card per workflow: name, enabled `Switch`, the trigger(s) in words ("Every 15 min · next
  14:45", "New tag v* · AppsStats/Apps-Stats", "Push to main · this project"), the last run's
  status dot + relative time; while running, a live line "▶ Step 3/7 · Codex review · 12m" with a
  thin progress bar. Actions: **Run now**, **Edit** (opens the editor tab), Duplicate, Delete
  (`ConfirmDialog`).
- Expanding a card lists its last 10 runs (status, trigger, duration); a run opens the editor tab
  in run view on that run.
- Footer: **Secrets** (a sheet/modal listing names, scope, updated; set/replace/delete; values
  write-only with a reveal-while-typing toggle).
- Empty state: an illustration-free designed empty state offering three starter templates from the
  owner's examples — *Nightly agent task*, *Jira ticket fixer*, *Release-tag reviewer* — and
  "Start from scratch".

### 7.2 The editor tab

A new client-local main-area tab kind `workflow` (`{id, type:"workflow", workflowId, title}` in a
`workflowTabsByProject` slice), one per workflow (reused if open), modelled on todo tabs (bound to a
record by id, title kept in sync by `workflow.upserted`); wired through every place that switches
on `tab.type` (`MainView`, `TabStrip`, `TabSwitcher`, `firstTabId`, `reassignActive`, project and
workspace cleanup). It opens in the project the rail is on; a workflow whose project is elsewhere
still opens there (the tab is a view, not a binding). The editor root is a `data-keyboard-surface`;
every popover/sheet registers `useOpenLayer`.

**Toolbar:** inline rename; enabled switch; save state (autosave 600 ms after the last change,
with `revision`; a 409 shows a banner "Changed elsewhere (e.g. by an agent via MCP) — Reload / Keep
mine (overwrite)"); Undo / Redo; **Tidy up** (dagre, left-to-right, animated); zoom − / + / fit;
**Run now** (with an optional JSON input popover); **Editor | Runs** toggle; ⚙ Settings (project,
overlap, timezone, notifications, run timeout, this workflow's secrets).

**Canvas** (`@xyflow/react`): dotted `Background`, `MiniMap` (toggleable), `Controls`, snap to a
16 px grid, box/multi-select, drag, arrow-key nudge (Shift = ×10), copy/paste (Ctrl/Cmd+C/V — JSON
on the clipboard with a marker, ids and names re-minted, positions offset; works across
workflows), Ctrl/Cmd+D duplicate, Delete/Backspace, Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z (a snapshot
history of the definition, 100 steps, coalescing drags), Ctrl/Cmd+A, sticky notes. Edges: smooth
step with rounded corners; success edges neutral, error edges red dashed, true/false/case edges
labelled; hovering an edge shows a "+" (insert a block) and "×".

**Adding blocks:** a searchable palette (left, collapsible) grouped *Triggers · Agents · Code ·
Flow · Integrations*, drag onto the canvas; the n8n **"+" on an output handle** adds and connects
in one step; Tab or double-click on empty canvas opens the same add menu at the pointer.

**Blocks** render as cards (min 220 px wide): a colour-coded icon tile and left accent by category
— triggers amber, agents violet, code/shell blue, HTTP teal, flow neutral — the name, a one-line
summary ("Claude Opus · High → Codex fallback", "Every 15 min", "POST api.atlassian.com/…"), a
validation badge (red, with the first problem on hover), a disabled look (dimmed, striped), and in
run view a status ring and duration. Input handle left; output handles right, labelled when more
than one (success green / failure red; true / false; each case).

**Inspector** (right, resizable 320–640 px) for the selected block, a form per type:

- **Agent:** prompt editor (CodeMirror, plain text with `{{…}}`/`{variable}` highlighting, autocomplete for
  `{{nodes.<Name>.output…}}` paths from upstream blocks' known output shapes and `{variables}`), or
  a saved-prompt picker with preview and an "append" field; session: new / continue from block;
  the **fallback chain** as drag-to-reorder rows, each: agent picker, model + effort pickers (the
  composer's pure helpers `optionDescriptors`, `resolveSelectedModel`, `applyModelSelection` over
  `useProviderSnapshots()`, rendered with `Dropdown`/sheets — not `ComposerPopover`, which is bound
  to chat tabs), and an **account policy** editor: strategy segmented control, threshold sliders for
  5h / weekly / scoped (Fable) windows, an account list with **live usage bars** (the Settings usage
  data) as allow-list or ordered list, "include System login", unknown-usage choice; a **"Who would
  run now?"** button (account-preview: the pick and every skip reason); toggles: autonomy note,
  when only watch loops remain, when all burnt (fail / wait for reset ≤ N h), max minutes.
- **Code:** full JS editor (the existing `files/Editor.tsx`, `filename="block.mjs"`), expandable to
  a large modal; a reference card of the arguments; **Test block**.
- **Shell:** script editor (bash), env mappings table (value fields accept `{{…}}` and a secret
  picker), timeout.
- **HTTP:** method, URL, query and header tables, body editor, success statuses, timeout, secret
  picker.
- **IF / Switch:** a no-code rule builder (left expression with path autocomplete, operator,
  right value), all/any.
- **Merge, Stop, Wait, Run workflow, Note:** small forms.
- **Triggers:** schedule preset builder with English text + next 5 times; git: repo picker (the
  workflow project, a repo from a git account's list, or a public URL), event kind and its filters,
  last poll status.
- Every block: name, notes, disabled, retry, timeout, project override; and a **Data** tab with
  **Input | Output** of the last run (collapsible JSON tree, copy) and **Pin output** / unpin.

**Validation** runs continuously (shared `validateWorkflow`): cycles, dangling edges, unknown
`{{nodes.X}}`, `{{…}}` in a shell script, a `continue` without an upstream agent block, an agent
chain entry whose model is not in the catalogue, a missing secret name, a trigger-less workflow
(allowed, manual only; shown as info). Errors block enabling (not saving); warnings (secrets in a
prompt, untrusted trigger text in a prompt) never block.

### 7.3 Run view

"Runs" mode, or automatically while a run the user started is live: a runs list (status, trigger,
started, duration; filter by status) beside the canvas; selecting a run renders **its frozen
definition** read-only with an overlay — per block a status ring (queued, running with a soft
pulse, waiting, succeeded, failed, skipped greyed, cancelled), duration, and for agents the account
and hop count; taken edges highlighted (animated while the target runs), dead edges greyed. The
inspector becomes the block's run detail: input, output, error, timings, attempts; for agents the
selection decision, the hops, "Working · 12m" with the latest activity line, and **Open session**
(focuses its chat tab); for code/shell a live log tail (following, with "download full log").
Buttons: **Cancel run**, **Retry run**, **Retry from failed block** (a new run re-using the
succeeded blocks' outputs from this one, starting at the failed blocks), "Delete temp project now".

Live data: block state changes on the `workflows` event channel (throttled); logs through `GET
/api/workflow-runs/:runId/nodes/:nodeId/log?offset=&follow=1` (chunked, only while viewed).

### 7.4 Phones

- The rail section is fully functional (list, filter, run now, enable, run history, secrets).
- The editor tab has a **Canvas | Steps** toggle, **Steps by default on phones**: a vertical
  outline of the workflow in topological order, branches indented under their handle label
  (*success / failure / true / false / case*). Tap a step to open its inspector; **"+ Add after"**
  on any output adds and connects in one tap; swipe or long-press → duplicate, disable, delete,
  move to another output. A whole workflow can be built from Steps alone. (The outline derivation
  is shared and tested: `packages/api/src/workflows/outline.ts`.)
- The canvas on touch: one-finger pan on empty space, pinch zoom; tap selects and opens the
  inspector; long-press a block → its menu (duplicate, disable, delete, *Connect from…*);
  long-press empty canvas → add a block there; handles have ≥ 28 px invisible hit areas; a
  **tap-to-connect** mode (tap an output chip, then a target block).
- Chrome: a compact top bar (back, name, enabled, overflow: Settings, Runs, Secrets) and a floating
  thumb-reach toolbar **Add · Undo · Redo · Fit · Tidy · Run**.
- The inspector is a full-height `BottomSheet` with a drag handle; forms are single-column; model,
  effort and account pickers open as sheets; sliders are finger-sized; code, shell and prompt
  editors open full screen with a key bar (`{ } ( ) [ ] ; : " ' = < > / \ | Tab`).
- Sheets track `visualViewport` so the soft keyboard never covers the focused field; as fixed
  overlays they pad their own safe-area insets (the app-shell rule).
- Run view on phones: a vertical timeline of steps with live states, durations and hops; tap a step
  for input/output/log; **Open session**; the canvas overlay one tap away.

### 7.5 Visual quality

Everything paints with the neutral scale and semantic tokens (`ok`, `danger`, `warn`, `info`), so
all seven schemes × light/dark look native; React Flow's CSS variables are mapped to them. Category
accents as above; running states pulse and edges animate, both disabled under
`prefers-reduced-motion`. Spacing, radii and typography follow the rail and composer. Checked with
Playwright screenshots at 1440×900, 390×844 and 360×740 in light and dark.

### 7.6 Test runs and pinned data

"Test block" runs one block with its upstream inputs taken from pinned outputs, else from the last
run's outputs; "Run from here" runs the downstream subgraph that way. An agent block in a test run
uses its pinned output when it has one; otherwise it runs for real after a confirmation ("This
starts a real agent session"). Test runs are runs (`test:true`), shown in history with a flask
marker.

## 8. API and MCP

### 8.1 REST (both transports, bearer auth on HTTP)

| Route | |
|---|---|
| `GET /api/workflows?projectPath=` · `POST /api/workflows` | list (summary + last run), create |
| `GET/PUT/DELETE /api/workflows/:id` | read; replace (`revision` required; 409 `REVISION_CONFLICT`); delete (cancels runs, deletes runs and secrets) |
| `POST /api/workflows/:id/patch` | `{revision, ops[]}` atomic (§8.2) |
| `POST /api/workflows/validate` | `{workflow}` → `{problems:[{nodeId?, field?, severity, code, message}]}` |
| `POST /api/workflows/:id/duplicate` | |
| `POST /api/workflows/:id/run` | `{input?, test?, fromNodeId?, retryOf?}` → `{runId}` or `{skipped:"overlap"}` |
| `POST /api/workflows/:id/nodes/:nodeId/test` | → `{runId}` |
| `GET /api/workflows/:id/runs?before=&limit=` · `GET /api/workflow-runs/:runId` | history; one run (per-block state, capped outputs with `…/output` for the whole) |
| `GET /api/workflow-runs/:runId/nodes/:nodeId/output` | a block's whole output |
| `GET /api/workflow-runs/:runId/nodes/:nodeId/log?stream=stdout|stderr&offset=&follow=1` | chunked |
| `POST /api/workflow-runs/:runId/cancel` · `…/delete-temp-project` | |
| `POST /api/workflows/account-preview` | `{chain, projectPath}` → selection decision |
| `GET /api/workflows/schedule-preview?cron=&tz=&count=` | `{text, next:[…]}` |
| `GET /api/workflows/block-types` | per-type JSON schema + example + expression guide |
| `GET /api/workflow-secrets?workflowId=` · `PUT/DELETE /api/workflow-secrets/:name?workflowId=` | names only · write-only |

Errors: `WorkflowError(status, code, message)` → `{error:{code, message, details?}}`; codes
`WORKFLOW_NOT_FOUND`, `RUN_NOT_FOUND`, `REVISION_CONFLICT`, `INVALID_WORKFLOW` (with `problems`),
`WORKFLOWS_UNAVAILABLE`, `LIMIT_EXCEEDED`, `SECRET_INVALID`.

**Events** on channel `"workflows"`: `workflow.upserted` (the summary), `workflow.deleted`,
`workflowRun.started`, `workflowRun.updated` (a delta: changed block states, ≤ 4/s per run),
`workflowRun.finished`, `workflowSecrets.changed` (names only). The client store is a module
zustand store like saved prompts (tolerant payload sanitising, idempotent events, stale-on-reconnect
reload).

### 8.2 Patch operations

`add_node {node}` (id/name/position optional — minted/placed), `update_node {nodeId|name, set:{…}}`
(config merged one level deep; `null` clears), `remove_node` (removes its edges), `rename_node
{from, to}` (rewrites every `{{nodes.<from>…}}` reference), `connect {source, sourceHandle,
target}`, `disconnect {edgeId | source, sourceHandle, target}`, `set_settings {…}`, `set_project
{…}`, `set_enabled {enabled}`, `set_pinned {nodeId, output|null}`. Applied in order to a copy,
validated, then saved atomically; any failure rejects the whole batch naming the op index. Nodes
added without a position are placed by the shared dagre layout.

### 8.3 MCP tools (`apps/daemon/src/mcp/tools/workflows.ts`, through `DaemonApi` only)

`list_workflow_block_types`, `list_workflows`, `get_workflow`, `create_workflow`,
`update_workflow` (patch ops + revision), `validate_workflow`, `delete_workflow` (`confirm: true`
required), `run_workflow` (`wait` with a timeout ≤ 10 min, bus-driven — returns the run summary or a
`runId` to poll), `list_workflow_runs`, `get_workflow_run`, `cancel_workflow_run`,
`list_workflow_secrets` (names), `set_workflow_secret` (write-only; its description warns the value
is in the caller's transcript). Results obey the MCP's 60 000-byte cap with explicit truncation
flags; errors use the `<CODE>: <message>` envelope; arguments are strict. `docs/orquester-mcp.md`
gains a Workflows section with a worked example (the Jira fixer built from a description).

## 9. Testing

`node:test` under each package's `src/**/*.test.ts`; no sleeps (MockTimers, bus events, drains).

- **packages/api:** workflow schema parse + tolerance; expression parser/renderer incl. hostile
  input (deep paths, huge strings, `{{` injection, filter errors); `validateWorkflow` (cycles,
  handles, references, shell-template refusal); dead-path readiness; patch ops (atomicity, rename
  rewriting); the Steps outline; prompt-variable resolver (moved tests kept green).
- **daemon:** service CRUD/revisions/tolerant load/corrupt move-aside; engine over a fake
  `DaemonApi` and fake clock for every block type, branching, merge modes, failure routing, retry,
  cancel, overlap policies, run timeout; account selection including the owner's literal example
  (therealeduard465 90% weekly vs 85% threshold → jasperclaude); **the failover matrix** — a limit at
  create, at turn start, mid-turn, while parked (Claude), during background work, during the account
  switch, across families with the handoff prompt, chain exhausted (fail and wait-for-reset), auth
  failure, and a daemon restart at every step of the loop — asserting *a limit never fails the
  block while an eligible candidate remains*; adapter classifier replay over each provider's
  recorded limit frames; resume at every `waitingOn` kind; scheduler (cron, time zones, DST,
  missed-run grace, no bursts); git poller over fake `ls-remote`/REST (baseline, dedup, coalescing,
  ETag 304, backoff); sandbox with real `node`/`bash` children (timeout and group kill, memory flag,
  output caps, scrubbed env, secret redaction, `stop()`, `require` from the project, survival of a
  simulated daemon restart); temp project lifecycle and sweepers; REST routes via `app.inject`.
- **ui:** store event application; undo history; clipboard re-minting; run-overlay derivation;
  localStorage loads through schemas; rail registration (`right-rail-render.check.ts`).
- **mcp:** create → patch → validate → run → get_run round trip; strict args; caps.
- **e2e:** Playwright on a separate checkout (never the live daemon): desktop 1440×900 and phones
  390×844 / 360×740 with touch — build a workflow in Steps, connect on the canvas, configure an
  agent block, run a code-only workflow, watch it live, light and dark. The web smoke test opens the
  editor tab.
- Gate: `pnpm check` and `pnpm test` clean.

## 10. Build order

1. **Foundations:** shared types/schemas/expressions/validation/patch/outline; storage, REST,
   events, secrets; `prompt-variables` moved to `packages/api`; the session `owner` field + tab
   chip; `reason`/`resetsAt` on runtime errors/warnings in every adapter; the chat-client module
   extracted from `mcp/`.
2. **Engine core:** run store, graph walk, code/shell sandbox, HTTP, IF/Switch/Merge/Stop/Wait,
   sub-workflow, persistence and resume, manual trigger, overlap, retention.
3. **Agent block:** selection, failover loop, cooldowns, watcher (auto-answer, done detection),
   temp projects and tab sweeper, notifications.
4. **Triggers:** scheduler; git poller (`lsRemote`, provider PR/release methods, clone `ref`).
5. **Desktop UI:** rail panel, editor tab, canvas, inspectors, run view, test runs, pinned data,
   secrets, templates.
6. **Phone UI:** Steps view, touch interactions, sheets, key bar.
7. **MCP tools + docs** (`docs/orquester-mcp.md`, an AGENTS.md "Automated workflows" section and
   gotchas).
8. **Polish:** full Playwright pass, visual review in all schemes, final code review.

## 11. Risks and mitigations

- **Unattended full-access agents** act with the daemon user's rights, like any full-access chat.
  Workflows only start from triggers the owner configured; nothing a trigger delivers is ever
  executed as code or shell text; prompt-injection warnings in the editor.
- **Agents blocking forever:** questions auto-answered, approvals accepted, plan cards implemented,
  `maxMinutes` + run timeout as backstops.
- **Stale usage data** (5-minute polls, Codex misattribution): cooldowns from real limit signals
  are authoritative over usage numbers; unknown usage is tried last.
- **Deploys mid-run:** runs resume (§5.8); detached sandbox children survive; the agent host
  survives on its own.
- **Disk growth:** retention sweepers for runs, logs, temp projects and workflow tabs; caps on every
  output.
- **A runaway schedule** (every minute × a long agent): the default overlap policy is skip.
