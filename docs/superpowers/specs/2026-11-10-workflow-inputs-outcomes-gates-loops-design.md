# Workflows: typed inputs, typed outcomes, gates and loops

Status: draft for review (2026-11-10).
Reference: the paseo-playbooks plugin (`github.com/lerenn/paseo-playbooks`, v0.51.0), studied for its
playbook semantics and the lessons in its ADRs. This spec does **not** port playbooks; it adds four
capabilities to the existing Workflows feature.

## 1. Intent

Workflows can already chain agents, run them in parallel, call sub-workflows and run scripts. Four
things stop them from expressing the common "do → review → fix until approved → ask a human" flow:

1. **Inputs are untyped.** "Run now" is a raw JSON textarea (`RunNowPopover.tsx`), prefilled from a
   free-text `inputExample` (`packages/config/src/workflows.ts:89`). Agents calling `run_workflow`
   have no schema to follow and get no input errors.
2. **Agent results are plain text.** An agent block outputs `{text, sessionId, …}`
   (`apps/daemon/src/workflows/agent/executor.ts:102`). Branching on "did the review pass?" needs a
   Code block that `JSON.parse`s the text, then a Switch; a malformed reply fails the run at the parse
   step, where the agent can no longer fix it.
3. **Nothing waits for a decision.** `wait` is a timer; workflow agents answer their own questions
   and approvals (`agent/watch.ts:206`); approval cards are in memory with a 30-minute limit.
4. **Loops are forbidden.** The validator rejects every cycle (`packages/api/src/workflows/validate.ts:342`).

The playbooks plugin's main lesson applies here: rules belong in the deterministic engine, and the
model is asked only for judgment, through tools that refuse bad calls with a reason it can act on.

## 2. Goals, non-goals, anti-goals

### Goals

- **G1 Typed inputs and a start form.** A manual trigger can declare typed inputs. "Run now" shows a
  form built from them; the daemon validates every run's input against them (GUI, REST, MCP).
- **G2 Typed outcomes and outputs.** An agent block can declare named outcomes and typed outputs. The
  agent reports them with a tool that validates the call. Each outcome is an output handle on the
  canvas, so branching needs no Code or Switch block.
- **G3 Gates.** A new Gate block pauses the run for a decision between named choices. Each choice is
  an output handle. The decider is a person (default), an assigned reviewer agent, or the agent
  that launched the run. The wait survives daemon restarts.
- **G4 Bounded loops.** An edge can loop back to an earlier block, with a limit and a session option
  ("continue in the same chat" or "start a new chat") that applies to every agent block the loop
  runs again.
- **G5 Both audiences.** Every capability is equally usable by a person in the GUI (desktop and phone)
  and by an agent through the MCP catalog.

### Non-goals

- Playbook YAML files in the repository, or any repo-file loader. Workflows stay in the appdir.
- Worktree isolation per run or per block, read-only roles, per-block permission modes. Agent blocks
  keep running unattended with full access, as today.
- A "manager" agent that drives the run. The engine drives it.
- Dynamic fan-out over a list, cross-run pipelines or merge queues.
- Importing paseo-playbooks files.

### Anti-goals (a failure even if it technically works)

- An existing workflow behaves differently. Every new field is optional; a workflow that uses none
  of them runs exactly as today.
- An agent decides a gate it was not assigned to, or a person cannot see or override a gate.
- A run sits silently stuck: a gate nobody is told about, a step that ended without a report and was
  never failed, a loop with no limit.
- An agent learns the rules only by trial and error: the authoring guide, block schemas and tool
  errors must state them.

## 3. Terms

- **Outcome:** a named result an agent block declares (`approved`, `changes_requested`). Exactly one
  is chosen per pass.
- **Report:** the agent's `report_step_result` call: outcome, summary, outputs.
- **Gate:** the new `gate` block. **Choice:** one of its options. **Decider:** who may decide it.
- **Loop edge:** an edge with `loop` settings that points from a block's output handle back to an
  ancestor block.
- **Pass:** one execution of a block within a run. Loops create new passes; a retry is an attempt
  within a pass (existing `retry` semantics unchanged).
- **Reset set:** the blocks a taken loop edge runs again: its target and every block downstream of
  the target through non-loop edges.

## 4. Typed inputs and the start form (G1)

### 4.1 Declaration

`trigger.manual` config gains an optional ordered `inputs` list:

```ts
inputs?: Array<{
  name: string;              // ^[A-Za-z][A-Za-z0-9_]{0,39}$, unique
  type: "string" | "number" | "boolean" | "enum";
  values?: string[];         // enum only, 1–50, unique
  required?: boolean;        // default false
  default?: string | number | boolean;   // must fit the type (and values)
  description?: string;      // ≤ 300 chars, shown as help text
  multiline?: boolean;       // string only: a textarea
}>                           // ≤ 30 entries
```

`inputExample` stays and is used only when `inputs` is absent.

### 4.2 Validation (daemon, at run creation)

When `inputs` is declared, the run's input must be an object. The daemon:

- applies defaults for absent keys; an explicit `null` counts as absent for an optional input and
  is a wrong type for a required one (with or without a default, also in a test run);
- rejects a missing required input, a wrong type, an enum value not in `values`, and unknown keys;
- coerces, and nothing else: for numbers, text that is a plain decimal numeral after trimming
  surrounding whitespace — an optional leading `-`, digits, an optional `.` followed by digits
  (`/^-?\d+(\.\d+)?$/`: `"42"` → 42, `"-1.5"` → -1.5; never `+`, a leading or trailing `.`, an
  exponent, hex/binary/octal or `Infinity`); for booleans, exactly `"true"`/`"false"` (agents send
  strings). An enum value must match one of `values` exactly.

Errors name the input and the fix, e.g. ``input `env` must be one of: stg, prd``. Every error is
returned at once, not the first only. The same check runs for the REST run route, MCP `run_workflow`,
and the GUI. The run's trigger payload stores the validated, defaulted input.

When `inputs` is absent, behaviour is unchanged (any JSON). The validator warns (not errors) when a
workflow with declared inputs references `{{ trigger.input.x }}` / the manual output's `input.x`
for an undeclared `x`. Schedule and git triggers are unaffected.

How a `workflow` (sub-workflow) block's input relates to the child's declared inputs is in §11.

### 4.3 The form

- "Run now" opens a form when `inputs` is declared: text (textarea when `multiline`), number,
  `Switch` for booleans, segmented/radio choice for enums, required marker, description as help
  text, defaults prefilled. Desktop: `Modal`; phone: `BottomSheet`/`WorkflowSheet`.
- Errors from the daemon show beside their field.
- An "Edit as JSON" toggle keeps the raw editor for power users; the daemon validates either way.
- The overlap "Run anyway" notice (`runWorkflowNow`) keeps working.
- The manual trigger's inspector gets an inputs editor (add, reorder, type, required, default,
  description, values). On phone, the step list editor gets the same fields.

## 5. Typed outcomes and outputs (G2)

### 5.1 Declaration

`agent` config gains two optional fields:

```ts
outcomes?: Array<{ id: string; label?: string; description?: string }>;
  // id ^[a-z][a-z0-9_]{0,39}$, unique, 2–12 entries
outputs?: Array<{
  name: string;                // same rules as input names
  type: "string" | "number" | "boolean" | "enum" | "json";
  values?: string[];           // enum only
  required?: boolean;          // default true
  description?: string;
}>;                            // ≤ 20 entries
```

- **Neither declared:** today's behaviour, no report.
- **`outputs` only:** a report is required, with no outcome; handles stay `success` / `error`.
- **`outcomes` declared:** handles become `outcome:<id>` (in declared order) plus `error`; the
  `success` handle is removed. `outputHandles` in `packages/api/src/workflows/graph.ts` derives them.
- `WORKFLOW_HANDLE_PATTERN` (`packages/config/src/workflows.ts:392`) only allows
  `success|error|true|false|default|case:n` today; it is widened to accept `outcome:<id>` and
  `choice:<id>` (§6). This is a widening of an existing check, not only a new optional field.

### 5.2 The report tool

A new catalog tool, chat audience only: **`report_step_result`**
`{ outcome?: string, summary: string (≤ 2,000 chars), outputs?: object }`.

- Every chat sees it (the in-chat server has no per-chat tool switch; `session-tools/README.md`).
  It succeeds only when the calling thread is the current session of a running pass of an agent
  block that declared `outcomes` or `outputs`. The match is the run plus the session ids the pass
  recorded (including sessions created by account/chain failover), **not** the session's
  `owner.nodeId`: a `session: continue` block reuses an upstream block's chat, whose owner names the
  node that created it (`agent/executor.ts:378, 467`). If two passes of different blocks could ever
  hold the same session at once, the most recently started running pass owns the report. Any other
  caller gets "This chat is not a workflow step that reports a result."
- It must never open an approval card (not Admin tier).
- It validates outcome ∈ declared ids, required outputs present, types (same coercion as §4.2),
  enum values, no unknown outputs. A refusal lists exactly what is wrong and the allowed values.
- A valid call is stored on the pass. A later valid call in the same pass replaces it (the agent can
  correct itself) until the block settles.
- The result says "Recorded. End your turn now." The tool does not end the turn.

### 5.3 Protocol, reminder and failure

- When `outcomes`/`outputs` are declared, the executor appends a protocol block to the prompt (like
  `autonomyNote`): the allowed outcomes with descriptions, the outputs with types, "call
  `report_step_result` once your work is done, as your last action", and "do not end your turn to
  wait on background work".
- When the turn settles with no stored report, the executor sends **one** reminder turn in the same
  session. If that turn also settles without a report, the pass fails with error kind `no_report`;
  the block's `retry` policy and `error` handle then apply as for any failure.
- The reminder must follow the existing "persist `WaitingOn` before the side effect" rule.

### 5.4 Output

The block output gains `outcome?: string`, `summary?: string`, `outputs?: object`, alongside the
existing fields. `text` stays. Expressions read `nodes.Review.output.outcome`,
`nodes.Review.output.outputs.pr_url`. Downstream readiness uses the chosen `outcome:<id>` handle; the
other outcome handles are dead edges (existing dead-path elimination).

## 6. Gates (G3)

### 6.1 Declaration

New node type `gate` (category `flow`):

```ts
{
  question: string;          // template, ≤ 300 chars rendered
  details?: string;          // template, Markdown, ≤ 8 KB rendered
  choices: Array<{
    id: string;              // ^[a-z][a-z0-9_]{0,39}$, unique, 2–8 entries
    label: string;
    color?: "default" | "primary" | "success" | "warning" | "danger";
    comment?: "none" | "optional" | "required";   // default "none"
  }>;
  decider:
    | { kind: "human" }                                   // default
    | { kind: "agent"; prompt: AgentPrompt; chain: AgentChainEntry[]; profileId?: string; maxMinutes?: number /* default 60 */ }
    | { kind: "launcher"; maxMinutes?: number /* default 60 */ };
  timeout?: { minutes: number; then: { kind: "choice"; choice: string } | { kind: "fail" } };
}
```

- A new gate from the palette defaults to choices `approve` ("Approve", primary) and `reject`
  ("Reject", danger, comment optional), decider human.
- Handles: `choice:<id>` for each choice, plus `error`.

**Phases and deadlines.** A gate has at most two phases, each with its own persisted deadline:

1. **Agent phase** (decider `agent` or `launcher` only): lasts until the agent decides, escalates,
   fails, or `decider.maxMinutes` passes. Anything but a decision moves the gate to the person phase.
2. **Person phase** (decider `human`, or after escalation): its deadline is `timeout.minutes` counted
   from the moment this phase starts. When it passes, `timeout.then` applies (take a choice, or fail
   with error kind `gate_expired`). With no `timeout`, the person phase lasts at most 7 days (the
   existing maximum wait), then fails with `gate_expired`. `timeout.minutes` ≤ 7 days.

`timeout` never applies to the agent phase, so an automatic choice can only happen after the person
has been asked. The person can decide during either phase. Both deadlines are re-armed from the
persisted values after a restart. The gate block is exempt from `blockTimeoutMs`'s 5-minute default
for unknown types (`run-context.ts:114`).

### 6.2 Engine

- Opening a gate renders `question`/`details`, then persists a new `WaitingOn` kind
  (`{kind: "gate", gateId, openedAt, deadlineAt, decider, phase, …}` in
  `apps/daemon/src/workflows/contracts.ts`) **before** any notification or decider launch.
- A gate wait is a wait state (`isWaitState` in `engine.ts:248`): it holds no agent or process
  slot.
- **A run is "parked"** when every active block in it is waiting on a gate, a timer, or a child run
  that is itself parked (so this propagates up through sub-workflows). Today the global cap counts
  every depth-0 run (`engine.ts:1426`) and the run timeout is one fixed deadline from `startedAt`
  (`engine.ts:1215`). This spec changes both:
  - A parked run does not count toward `maxConcurrentRuns`; it re-enters the count (and may queue)
    when it un-parks.
  - Parked time is excluded from `runTimeoutMinutes`. This needs a new persisted mechanism (e.g.
    accumulated parked milliseconds plus the current parked-since time) re-armed on restart.
- **A parked run still counts for its own workflow's `overlap` and `maxConcurrent`** (no second
  deploy while one awaits approval). A run skipped or queued for that reason records the reason
  ("previous run is waiting on gate <question>") in the run list and its toast, so the skip is
  never silent.
- A decision is persisted in the run before the engine moves on. The first decision wins; a later
  one returns `{alreadyDecided: true, choice, decidedBy}` and changes nothing.
- On restart, a waiting gate resumes: its deadline is re-armed, and an agent decider resumes like an
  agent block does.
- Cancelling the run cancels the gate (and its decider agent).
- Output: `{ choice, comment?, decidedBy: { kind: "human" | "external" | "agent" | "launcher" | "timeout", label, sessionId? }, decidedAt, escalated: boolean }`.

### 6.3 Deciders

- **Person (`human`).** The person decides in the GUI. An external MCP client (the user's own
  authenticated tooling) also counts as the person, recorded as `external`.
- **Reviewer agent (`agent`).** The gate launches a new agent chat with the same machinery as an
  agent block (chain, accounts, profile, unattended, owner stamped with the gate's node). Its prompt
  is the decider prompt plus the rendered question, details and choices and the decision protocol.
  It decides with `decide_workflow_gate` (§8) or escalates. If its turn settles without a decision
  it gets one reminder; after that, or if it fails, times out or is archived, the gate escalates to
  the person.
- **Launching agent (`launcher`).** Only when the run was started by a chat through `run_workflow`.
  The run records `startedBy: { kind: "thread", sessionId }` (new optional field; GUI/REST runs record
  `{kind: "human"}`, schedule/git runs `{kind: "trigger"}`). `RunWorkflowRequest` has no caller field
  today and `run_workflow` posts to the plain REST route (`mcp/tools/workflows.ts:1381`): the thread
  identity is set by the daemon from the in-chat caller, never accepted from a remote client, and
  stripped on the remote transport like `causedBy` on the agent-chat wire. A child run inherits its
  top-level run's `startedBy`, so a gate inside a sub-workflow asks the same launcher.
  When the gate opens, the daemon queues a message into that chat (as a queued turn, never steering
  a running turn) with the workflow, run, question, details, choices and the exact tool call to make.
  If the run was not started by a chat, or that chat is gone or archived, the gate goes straight to
  the person phase; if the launcher does not decide within `decider.maxMinutes`, it escalates.
- **Rules for every agent decider:** only the assigned chat may decide; any other in-chat caller gets
  "Only <decider label> may decide this gate." A comment is required when an agent decides. While an
  agent is deciding, the person can still decide first. Escalation sends the push and attention
  entries of §6.4 and records `escalated: true`.
- If `run_workflow` was called with `wait: true` and a gate opens for the launcher anywhere in the
  run tree (including a sub-workflow), the call returns at once with the pending gate in its result,
  so the launcher is not stuck inside its own call.
- **Authorization of `decide_workflow_gate` for in-chat callers.** The assigned decider is known from
  daemon records (the decider agent's session id, or `startedBy`), never from the arguments. For that
  caller the tool is Act tier and its scope claim is the gate's own run, so it never opens an Admin
  or boundary card, including for a workflow-owned reviewer agent (Admin is unavailable to
  workflow-owned chats, `mcp/gate/policy.ts:176`) and for a launcher in another project
  (`policy.ts:202-247`). Every other in-chat caller is refused without a card. A launcher whose
  current turn is planning gets the existing planning refusal; it can decide after planning, or the
  gate escalates at `maxMinutes`.

### 6.4 Surfaces

Whenever a gate is waiting for the person (decider `human`, or escalated):

- **Push** through `PushService` (a new gate notification beside `notifyWorkflowRun`), deep-linking
  to the run with the gate selected (`sw.js` / `pwa.ts` / `WorkflowsHost.tsx` deep-link path).
- **Attention:** a "Needs you" row per waiting gate in the sidebar's workflow attention
  (`WorkflowAttention.tsx`, today failed runs only), with workflow, gate question, project and age;
  a count pill; and a warn dot on the Workflows activity-bar icon (`ActivityBar.tsx:70`).
- **Decision card:** in the run view (on the gate node and in the details pane) and in the
  Workflows panel card of that workflow. It renders question, details (Markdown, collapsed), and one
  button per choice in its color. Each button shows where it leads, computed from the choice
  handle's edges: "→ Deploy", "↺ Fix" for a loop edge, "→ End" when nothing is connected. A choice
  with `comment` optional/required expands a comment box; Send stays disabled while a required
  comment is empty. Built on `BannerCard` with `ToolApprovalCard`'s guards (no autofocus, keyboard
  delay, double-click guard). Phone: a bottom sheet.
- After deciding: a toast ("Approve: sent" / "Already decided: Reject by <who>"), the card turns
  into a record line ("approved by <who>, <time>: <comment>"), badges update immediately.
- While an agent decides, the card says "<agent> is deciding; you can decide first."

## 7. Loops (G4)

### 7.1 Declaration

An edge gains optional `loop`:

```ts
loop?: { maxLoops: number /* 1–20 */; session: "continue" | "new" /* default "continue" */ }
```

Validation (replacing the blanket cycle error):

- The graph without loop edges must be acyclic (the existing cycle check runs on it, with its
  message updated to point at loop edges).
- A loop edge's target must be an ancestor of its source through non-loop edges, and not a trigger.
- A loop edge may leave any output handle except `error` (agent outcomes, gate choices, if/switch).
- A handle with a loop edge carries nothing else: exactly one loop edge and no ordinary edges
  (ordinary targets would sit inside the reset set and be reset at once).
- An ordinary edge to an ancestor is reported as "make this a loop edge with a limit", not just "cycle".

**Graph helpers.** Every helper in `packages/api/src/workflows/graph.ts` treats every edge as a
forward edge today: `adjacency` (:78), `topologicalOrder` (:95, which returns null on any cycle),
`computeReadiness` (:247), `upstreamOf` / `downstreamOf` (:184-191), and the engine's block orders
that use them (`engine.ts:1451, 1578`). All of them, plus dagre layout and retry seeding, work on the
graph **without loop edges**. A loop edge never counts as a pending incoming edge for readiness;
it is followed only by the loop mechanism below.

### 7.2 Engine

- Each loop edge has a counter, persisted in the run.
- **Taking a loop edge with count < `maxLoops`:** increment the counter; interrupt any block of the
  reset set that is still running; mark every block of the reset set pending as a new pass; recompute
  taken/dead edges for them; continue scheduling. Counters of loop edges whose source and target are
  both inside the reset set go back to 0 (an outer loop gives inner loops a fresh budget).
- **Taking it at count = `maxLoops`:** open a loop-limit gate (decider: person) on the source block:
  "<source> → <target> reached its limit (N)." Choices: "Allow one more loop" (raises that edge's
  limit by one for this run and takes it) and "Stop" (the source pass fails with error kind
  `loop_limit`; its `error` handle or run failure then applies). It uses the surfaces of §6.4.
- **Feedback** for the target's next pass: the source's report `summary` (agent outcome), or the gate
  decision's choice label and comment (gate choice), or nothing (if/switch).
- Expressions: `nodes.X.output` is always the latest pass. A new `loop` namespace gives
  `{{ loop.pass }}` (1-based pass number of the current block) and `{{ loop.feedback }}`.
- Earlier passes stay in the run: status, output, error, sessions, report, decision. They are
  inspectable in the GUI and in `get_workflow_runs`.
- Everything keyed by attempt today must stay unique across passes: deterministic child-run ids
  (`(parentRunId, nodeId, attempt)`, `engine.ts:228`) and attempt directories
  (`nodes/<nodeId>/<attempt>/`). Otherwise pass 2's sub-workflow block would re-bind pass 1's child
  run. Either attempt numbers keep counting across passes or the key gains the pass.
- `loop_limit` and `gate_expired` join `NOT_RETRIED` (`engine.ts:236`): a block's `retry` policy
  never re-runs after the person chose "Stop" or a gate expired. `no_report` stays retryable.

### 7.3 The session option

The loop edge's `session` applies to **every agent block in the reset set** (and to a reviewer-agent
gate decider in the reset set):

- **`continue`:** the block sends a follow-up turn into the session of its previous pass. The
  message is a short header ("Workflow loop: pass 2 of up to 3"), the feedback block (target only),
  and the block's prompt re-rendered against the new upstream outputs. For a non-target block
  (e.g. the reviewer) the header says the earlier steps ran again and to re-check its earlier
  findings. The reporting protocol of §5.3 applies again.
- **`new`:** the block starts a new chat. Its prompt is the re-rendered prompt plus the feedback
  block (target only) and the previous pass's report/outputs.
- If `continue` is impossible (no previous session, the session is archived or deleted, or failover
  moved to an agent whose session cannot take the turn), that block starts a new chat and the pass
  is marked "new chat: previous session unavailable (<reason>)" in the run view.
- Blocks with `session: { kind: "continue", fromNode }` keep continuing their configured upstream
  session.
- Non-agent blocks (code, shell, http, flow) simply run again.

### 7.4 Canvas and run view

- Editor: dragging a connection from a handle onto an upstream block creates a loop edge with
  `maxLoops: 2, session: "continue"`; the edge inspector (or popover) edits both settings.
- Loop edges are drawn dashed and routed back; dagre layout (`packages/api/src/workflows/layout.ts`)
  ignores them for ranking.
- Run view: the loop edge label shows "<handle> · used/max" and fades when exhausted; a block with
  several passes shows pass chips (#1, #2, …) that open that pass's details and chat.
- Phone: the step list shows a loop as a "↺ back to <target> (max N, same chat/new chat)" row under
  its source; the run timeline lists passes.

### 7.5 Interactions with existing run features

- **Retry and "Retry from failed block".** Gate decisions are never seeded: a retry asks every gate
  again. Loop counters start at 0. Succeeded blocks are seeded from their latest pass, using the
  graph without loop edges (`engine.ts:1594-1609`). A run that failed with `loop_limit` can be
  retried and gets a fresh budget.
- **Disabled blocks.** A disabled block passes its input through on `success` today
  (`engine.ts:742-748`). A disabled agent block with outcomes passes through on its first outcome;
  a disabled gate takes its first choice. The validator warns about both.
- **Pinned outputs** (`engine.ts:1625-1628`). A pin on an agent block with outcomes must include an
  `outcome`, which picks the handle; a pin on a gate must include a `choice`.
- **Test runs and "Test one block".** A gate in a test run opens for the person in the editor's run
  view only: no push, no attention row, no launcher message, no agent decider (the person who
  started the test answers it). Input validation in test runs and `testNode` (which sends
  `input: null`, `engine.ts:2167`) applies defaults but does not fail on missing required inputs.
  Retries reuse the source run's validated payload (`engine.ts:2121`) without re-validating against
  a later inputs change.

## 8. Agent surface (MCP)

- **`report_step_result`** (§5.2), chat audience only.
- **`decide_workflow_gate`** `{ runId, gateId?: string, nodeName?: string, choice: string, comment?: string }`
  or `{ …, escalate: true, comment }` (agent deciders only). Both audiences. In-chat callers succeed
  only as the assigned decider; external callers decide as the person.
- **`list_workflow_gates`** `{ project?: string, includeDecided?: boolean }`: waiting gates across
  projects with workflow, run, question, choices, decider and age. Read tier.
- **`run_workflow`:** validates input (§4.2) and lists all errors; records `startedBy`; with
  `wait: true` returns early on a launcher gate (§6.3).
- **`get_workflow` / `list_workflows`:** include the manual trigger's declared inputs, so an agent
  knows what to pass.
- **`get_workflow_runs`:** includes outcome, summary, outputs, passes, loop counters, waiting gates
  and decisions.
- **`create_workflow` / `update_workflow`:** the `connect` op accepts `loop`; schemas for the new
  agent fields and the gate block are in `list_workflow_block_types`.
- **Authoring guide** (`packages/api/src/workflows/guide.ts`): replaces, as one set, the "no loop
  block / `cycle`" rule (:751), the "parse it in a Code block" guidance (:256, :501) and the worked
  JSON-parse example (:647-678) with outcomes, gates and loop edges, with a worked
  "fix → review → loop → gate" example. `docs/orquester-mcp.md` documents the new tools.
- All tool results stay compact and say what the caller should do next (e.g. "Gate opened; the
  launcher was asked to decide").

## 9. Persistence and compatibility

- All new fields are optional, added to the `looseObject` schemas in `packages/config/src/workflows.ts`
  and the API types; records written by older or newer daemons keep unknown fields.
- A new node type (`gate`), new handle names (`outcome:<id>`, `choice:<id>`) and a new edge field
  (`loop`) are written into `workflows.json`. An older daemon already puts a workflow it cannot parse
  into `rejected` and writes it back unchanged (`packages/config/src/workflows.ts:465-492`): the
  workflow disappears from that daemon's list but is not destroyed. That is acceptable; the release
  note says so.
- Run records gain passes, loop counters, gate decisions and `startedBy`. An older run without them
  reads as today.
- Gate waits and loop counters follow the engine's rule: persisted before any side effect, resumed on
  restart.

## 10. Decisions

**Made by the user:**

- Scope: exactly these four capabilities, inside Workflows (no YAML playbooks, no worktrees).
- The loop's session behaviour is an option on the loop: "continue in the same chat" or "start a new
  chat".
- That option applies to every agent block the loop runs again, not only to the loop's target.
- An agent can decide a gate.

**My calls (check these while reading):**

- `continue` is the default session option.
- Agent deciders come in two forms (assigned reviewer agent, launching agent); the person can always
  decide first; agents must comment; failure or silence escalates to the person.
- Exhausting a loop opens a loop-limit gate for the person instead of failing silently.
- Loops reset the target and **all** its downstream blocks, interrupting ones still running.
- An outer loop resets inner loops' counters.
- Unknown input keys are rejected; only number/boolean strings are coerced.
- Gate waits are excluded from the run timeout; gates expire after 7 days at most.
- A report can be corrected within the pass; one reminder before failing with `no_report`.
- A loop edge may leave any non-error handle, including if/switch; a handle with a loop edge carries
  nothing else.
- Gate phases (§6.1): an agent phase bounded by `decider.maxMinutes` (default 60), then a person
  phase bounded by `timeout`; an automatic choice can only happen in the person phase.
- `decide_workflow_gate` is Act tier with a card-free path for the assigned decider only (§6.3).
- Sub-workflow gates ask the top-level run's launcher; parked runs (gates, timers, parked children)
  free the global cap and pause the run timeout, but still count for their workflow's own overlap,
  with the skip reason shown.
- Retries ask gates again and reset loop counters; disabled agents/gates take their first
  outcome/choice; test-run gates are answered in the editor only (§7.5).

## 11. Left to the builder

- The exact run-record shape for passes and how attempt directories map to passes.
- The tool tier of `report_step_result` (anything that never shows a card).
- The edge-settings UI (inspector panel or popover).
- Whether malformed `report_step_result` calls are repaired (the playbooks plugin needed this) or
  only refused with a precise error.
- Whether a `workflow` block's input is validated against the child's declared inputs (recommended:
  yes, failing the block with the same error list).
- How parked time is persisted for the run timeout (requirement in §6.2).
- Whether attempt numbers keep counting across passes or keys gain the pass (requirement in §7.2).

## 12. Testing

- **Validator:** inputs declarations, outcome/output declarations, gate config, loop-edge rules
  (allowed loop, ordinary back-edge, loop to a non-ancestor, loop from `error`).
- **Engine:** outcome handles and dead edges; `no_report` after one reminder; gate decided by each
  decider kind, first-wins, escalation, both phase deadlines; loop pass/counter/reset-set behaviour,
  limit gate, nested counter reset, interruption of running reset-set blocks; both session options
  and the continue fallback; parked runs and the cap, run timeout and overlap; retry, disabled,
  pinned and test-run behaviour of §7.5; child-run ids unique across passes.
- **Graph helpers:** readiness, topological order and up/downstream with loop edges present.
- **Restart:** a run restarted while waiting on a gate, while an agent decider runs, between loop
  passes, and while a reminder is pending.
- **MCP:** `report_step_result` caller checks and errors; `decide_workflow_gate` authorization;
  `run_workflow` input errors and early return; `list_workflow_gates`.
- **UI logic:** form building and validation display, choice destination labels, attention counts,
  loop-edge labels and pass chips (logic tests beside the changed files).
