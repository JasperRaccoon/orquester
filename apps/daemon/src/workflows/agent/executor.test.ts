import assert from "node:assert/strict";
import test from "node:test";
import type { AgentChainEntry } from "@orquester/api";
import { AUTONOMOUS_ANSWER, AUTONOMY_NOTE, CONTINUE_AFTER_SWITCH } from "./prompt.ts";
import type { AgentBlockOutput } from "./executor.ts";
import { byAccount } from "./testing/fake-chat-host.ts";
import { account, agentNode, fakePrompts, testWorkflow } from "./testing/fake-context.ts";
import { Scenario } from "./testing/scenario.ts";

const CLAUDE = [account("claude", "a1", "alpha"), account("claude", "a2", "beta"), account("claude", "a3", "gamma")];
const CODEX = [account("codex", "c1", "cx-one"), account("codex", "c2", "cx-two")];
const FIXED = { strategy: "fixed", includeSystem: false, soonestResetWindow: "weekly", leastUsedMetric: "max", unknownUsage: "last" } as const;

function chain(...entries: [string, string, string[]?][]): AgentChainEntry[] {
  return entries.map(([agent, model, accounts]) => ({ agent, model, accounts: { ...FIXED, ...(accounts ? { accounts } : {}) } }));
}

function outputOf(result: Awaited<ReturnType<Scenario["run"]>>["result"]): AgentBlockOutput {
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  return (result as { output: AgentBlockOutput }).output;
}

test("happy path: creates the session like the MCP, sends the prompt with the autonomy note, returns the last message", async () => {
  const json = '{"fixed":3,"skipped":[]}';
  const sc = new Scenario({
    accounts: CLAUDE,
    behaviour: () => [{ kind: "say", text: "Looking…", messageKind: "commentary" }, { kind: "wait", ms: 2_000 }, { kind: "say", text: json }]
  });
  const wf = testWorkflow([agentNode("n1", {}, "Fixer")]);
  const { result, fc } = await sc.run(wf, "n1");
  const out = outputOf(result);
  assert.equal(out.text, json, "a JSON-only answer is passed through untouched");
  assert.equal(out.agent, "claude");
  assert.equal(out.model, "opus");
  assert.equal(out.accountId, "a1");
  assert.equal(out.hops.length, 1);
  assert.equal(out.hops[0]!.via, "initial");
  assert.ok(out.hops[0]!.endedAt);
  assert.ok(out.durationMs >= 7_000, "the 5 s quiet window is part of the run");

  const create = sc.host.calls.find((c) => c.method === "POST" && c.path === "/api/sessions")!;
  const body = create.body as Record<string, unknown>;
  assert.equal(body.kind, "agent-chat");
  assert.equal(body.refId, "claude");
  assert.equal(body.accountId, "a1");
  assert.equal(body.projectPath, "/w/ws/app");
  assert.equal(body.cwd, "/w/ws/app");
  assert.equal("model" in body, false, "the model rides the chat selection only");
  assert.deepEqual(body.chat, { accountId: "a1", modelSelection: { model: "opus", options: [] }, runtimeMode: "full-access" });
  assert.deepEqual(body.owner, { kind: "workflow", workflowId: "wf-1", runId: "run-1", nodeId: "n1" });

  const session = sc.host.sessionsOwnedBy("n1")[0]!;
  const turn = session.commands.find((c) => c.name === "turn")!;
  assert.equal(turn.body.interactionMode, "default");
  assert.equal(turn.body.input, "Fix the bug.\n\nYou are running unattended inside an automated workflow. No human will answer. Never ask questions or wait for confirmation; make reasonable decisions and complete the task fully.");
  assert.equal("agent" in turn.body, false);
  assert.equal(fc.persisted.at(-1), undefined, "the waitingOn is cleared at the end");
  assert.equal(sc.host.listenerCount(), 0, "every bus subscription is released");
});

test("continue-session mode: a follow-up turn into the upstream block's session; its text only", async () => {
  const sc = new Scenario({
    accounts: CLAUDE,
    behaviour: (t) => [{ kind: "say", text: t.turnNumber === 1 ? "first answer" : "second answer" }]
  });
  const wf = testWorkflow([agentNode("n1", {}, "Writer"), agentNode("n2", { session: { kind: "continue", fromNode: "Writer" }, prompt: { kind: "text", text: "Now test it." } }, "Tester")]);
  const first = outputOf((await sc.run(wf, "n1")).result);
  const { result } = await sc.run(wf, "n2", { upstream: { Writer: first } });
  const out = outputOf(result);
  assert.equal(out.sessionId, first.sessionId, "the same session");
  assert.equal(out.text, "second answer");
  assert.equal(out.accountId, "a1");
  assert.equal(sc.host.sessions.size, 1, "no new session");
  const session = sc.host.session(first.sessionId);
  assert.equal(session.turns.length, 2);
  assert.equal(sc.host.turnLog[1]!.input, `Now test it.\n\n${AUTONOMY_NOTE}`);
});

test("continue-session mode without an upstream session fails as a validation error", async () => {
  const sc = new Scenario({ accounts: CLAUDE });
  const wf = testWorkflow([agentNode("n2", { session: { kind: "continue", fromNode: "Writer" } }, "Tester")]);
  const { result } = await sc.run(wf, "n2");
  assert.equal(result.status, "failed");
  assert.equal((result as { error: { kind: string } }).error.kind, "validation");
  assert.equal(sc.host.sessions.size, 0);
});

test("a saved prompt + append renders {{…}} first, escaped for the {variables} pass, then the variables", async () => {
  const prompts = fakePrompts({ saved: { p1: { title: "Fix", body: "Fix {project} on {branch}: {{ trigger.title }}" } } });
  const sc = new Scenario({ accounts: CLAUDE, prompts });
  const wf = testWorkflow([agentNode("n1", { prompt: { kind: "saved", promptId: "p1", append: "Also {{ input.extra }}." }, autonomyNote: false })]);
  const { result } = await sc.run(wf, "n1", { trigger: { title: "leak {diff} and {branch}" }, input: { extra: "run {project}" } });
  outputOf(result);
  assert.equal(sc.host.turnLog[0]!.input, "Fix app on main: leak {diff} and {branch}\n\nAlso run {project}.", "values inserted by {{…}} are never rendered as variables");
});

test("a failed variable read fails the block naming it, and no session is created", async () => {
  const sc = new Scenario({ accounts: CLAUDE, prompts: fakePrompts({ failVariable: "diff" }) });
  const wf = testWorkflow([agentNode("n1", { prompt: { kind: "text", text: "Review {diff}" } })]);
  const { result } = await sc.run(wf, "n1");
  assert.equal(result.status, "failed");
  const error = (result as { error: { kind: string; message: string } }).error;
  assert.equal(error.kind, "expression");
  assert.match(error.message, /\{diff\}/);
  assert.equal(sc.host.sessions.size, 0);
});

test("a missing saved prompt fails the block", async () => {
  const sc = new Scenario({ accounts: CLAUDE });
  const wf = testWorkflow([agentNode("n1", { prompt: { kind: "saved", promptId: "gone" } })]);
  const { result } = await sc.run(wf, "n1");
  assert.equal((result as { error: { kind: string } }).error.kind, "validation");
});

test("questions are answered autonomously: custom text where allowed, else (Recommended), else the first option — message-mode too, never dismissed", async () => {
  const sc = new Scenario({
    accounts: CLAUDE,
    behaviour: () => [
      {
        kind: "ask",
        questions: [
          { id: "q-free", header: "Name", question: "Which name?", options: [{ label: "foo", description: "" }], allowCustomAnswer: true },
          { id: "q-rec", header: "DB", question: "Which DB?", options: [{ label: "MySQL", description: "" }, { label: "Postgres (Recommended)", description: "", value: "pg" }] },
          { id: "q-first", header: "Color", question: "Which color?", options: [{ label: "red", description: "" }, { label: "blue", description: "" }] },
          { id: "q-multi", header: "Tags", question: "Which tags?", options: [{ label: "a", description: "" }, { label: "b", description: "" }], multiSelect: true }
        ]
      },
      { kind: "ask", responseMode: "message", questions: [{ id: "q-async", header: "Later", question: "Continue?", options: [], allowCustomAnswer: true }] },
      { kind: "say", text: "answered all" }
    ]
  });
  const wf = testWorkflow([agentNode("n1")]);
  const out = outputOf((await sc.run(wf, "n1")).result);
  assert.equal(out.text, "answered all");
  const session = sc.host.session(out.sessionId);
  const answers = session.commands.filter((c) => c.name === "answer").map((c) => c.body.answers);
  assert.deepEqual(answers[0], { "q-free": AUTONOMOUS_ANSWER, "q-rec": "pg", "q-first": "red", "q-multi": ["a"] });
  assert.deepEqual(answers[1], { "q-async": AUTONOMOUS_ANSWER });
  assert.equal(sc.host.commandCount("dismiss"), 0);
});

test("an approval is accepted", async () => {
  const sc = new Scenario({ accounts: CLAUDE, behaviour: () => [{ kind: "approval" }, { kind: "say", text: "ran it" }] });
  const out = outputOf((await sc.run(testWorkflow([agentNode("n1")]), "n1")).result);
  assert.equal(out.text, "ran it");
  const approval = sc.host.session(out.sessionId).commands.find((c) => c.name === "approval")!;
  assert.equal(approval.body.decision, "accept");
});

test("a plan card is implemented with the plan implementation prompt", async () => {
  const sc = new Scenario({
    accounts: CLAUDE,
    behaviour: (t) => (t.turnNumber === 1 ? [{ kind: "plan", markdown: "1. do it" }] : [{ kind: "say", text: "implemented" }])
  });
  const out = outputOf((await sc.run(testWorkflow([agentNode("n1")]), "n1")).result);
  assert.equal(out.text, "implemented");
  assert.match(sc.host.turnLog[1]!.input, /^PLEASE IMPLEMENT THIS PLAN:\n1\. do it/);
});

test("done only after background work ends (then the quiet window)", async () => {
  const sc = new Scenario({
    accounts: CLAUDE,
    behaviour: () => [{ kind: "say", text: "spawned" }, { kind: "background", steps: [{ kind: "wait", ms: 90_000 }, { kind: "say", text: "sub done", agentId: "sub" }] }]
  });
  const start = sc.clock.now().getTime();
  const out = outputOf((await sc.run(testWorkflow([agentNode("n1")]), "n1")).result);
  assert.equal(out.text, "spawned");
  assert.ok(sc.clock.now().getTime() - start >= 95_000, "finished only after the background work and the quiet window");
});

test("whenOnlyWatchLoopsRemain: finish ends after a 60 s grace; wait keeps waiting until maxMinutes", async () => {
  const behaviour = () => [{ kind: "say" as const, text: "server up" }, { kind: "background" as const, liveness: "monitoring" as const, forever: true, steps: [] }];
  const sc = new Scenario({ accounts: CLAUDE, behaviour });
  const start = sc.clock.now().getTime();
  const out = outputOf((await sc.run(testWorkflow([agentNode("n1")]), "n1")).result);
  assert.equal(out.text, "server up");
  const took = sc.clock.now().getTime() - start;
  assert.ok(took >= 60_000 && took < 80_000, `took ${took}`);

  const sc2 = new Scenario({ accounts: CLAUDE, behaviour });
  const { result } = await sc2.run(testWorkflow([agentNode("n1", { whenOnlyWatchLoopsRemain: "wait", maxMinutes: 10 })]), "n1");
  assert.equal((result as { error: { kind: string } }).error.kind, "timeout");
});

test("a background agent waking the parent into a provider-started turn is waited for; its text is the output", async () => {
  const sc = new Scenario({
    accounts: CLAUDE,
    behaviour: () => [
      { kind: "say", text: "started a helper" },
      { kind: "background", steps: [{ kind: "wait", ms: 20_000 }, { kind: "wake", steps: [{ kind: "wait", ms: 3_000 }, { kind: "say", text: "helper reported: all green" }] }] }
    ]
  });
  const out = outputOf((await sc.run(testWorkflow([agentNode("n1")]), "n1")).result);
  assert.equal(out.text, "helper reported: all green");
  assert.equal(sc.host.session(out.sessionId).turns.length, 2);
});

test("a wake that becomes a turn only 20 s after the background work ended is still waited for (a held Claude wake)", async () => {
  const behaviour = () => [
    { kind: "say" as const, text: "started a helper" },
    { kind: "background" as const, steps: [{ kind: "wait" as const, ms: 10_000 }, { kind: "wake" as const, delayMs: 20_000, steps: [{ kind: "say" as const, text: "helper reported: all green" }] }] }
  ];
  const sc = new Scenario({ accounts: CLAUDE, behaviour });
  const out = outputOf((await sc.run(testWorkflow([agentNode("n1")]), "n1")).result);
  assert.equal(out.text, "helper reported: all green", "the woken reply, not the launch message");
  assert.equal(sc.host.session(out.sessionId).turns.length, 2);


});

test("background work that ended with no wake finishes after the 90 s wake window", async () => {
  const sc = new Scenario({
    accounts: CLAUDE,
    behaviour: () => [{ kind: "say", text: "spawned" }, { kind: "background", steps: [{ kind: "wait", ms: 10_000 }] }]
  });
  const start = sc.clock.now().getTime();
  const out = outputOf((await sc.run(testWorkflow([agentNode("n1")]), "n1")).result);
  assert.equal(out.text, "spawned");
  const took = sc.clock.now().getTime() - start;
  assert.ok(took >= 100_000 && took < 130_000, `took ${took}`);
});

test("a quiet window catches a wake that comes right after the turn settles", async () => {
  const sc = new Scenario({
    accounts: CLAUDE,
    behaviour: () => [
      { kind: "say", text: "first" },
      { kind: "background", liveness: "monitoring", steps: [{ kind: "wait", ms: 1 }, { kind: "wake", steps: [{ kind: "say", text: "woken" }] }] }
    ]
  });
  const out = outputOf((await sc.run(testWorkflow([agentNode("n1")]), "n1")).result);
  assert.equal(out.text, "woken");
});

test("maxMinutes interrupts the agent and fails the block with timeout", async () => {
  const sc = new Scenario({ accounts: CLAUDE, behaviour: () => [{ kind: "say", text: "working" }, { kind: "hang" }] });
  const { result } = await sc.run(testWorkflow([agentNode("n1", { maxMinutes: 30 })]), "n1");
  assert.equal(result.status, "failed");
  assert.equal((result as { error: { kind: string } }).error.kind, "timeout");
  assert.equal(sc.host.commandCount("interrupt"), 1);
  const turn = [...sc.host.sessions.values()][0]!.turns[0]!;
  assert.equal(turn.state, "interrupted");
});

test("the run's cancel interrupts the agent and ends the block cancelled", async () => {
  const sc = new Scenario({ accounts: CLAUDE, behaviour: () => [{ kind: "hang" }] });
  const fc = sc.context(testWorkflow([agentNode("n1")]), "n1");
  const running = sc.executor().execute(fc.ctx);
  sc.clock.setTimeout(() => fc.abort(), 60_000);
  const result = await sc.clock.drive(running);
  assert.equal(result.status, "cancelled");
  assert.equal(sc.host.commandCount("interrupt"), 1);
});

test("a failed turn without a limit/auth reason is an agent_error with the host's message", async () => {
  const sc = new Scenario({ accounts: CLAUDE, behaviour: () => [{ kind: "fail", message: "The CLI crashed (exit 3)." }] });
  const { result } = await sc.run(testWorkflow([agentNode("n1")]), "n1");
  const error = (result as { error: { kind: string; message: string } }).error;
  assert.equal(error.kind, "agent_error");
  assert.equal(error.message, "The CLI crashed (exit 3).");
});

test("the live fields: selection, sessionId, hops and a throttled activity line", async () => {
  const sc = new Scenario({ accounts: CLAUDE, behaviour: () => [{ kind: "say", text: "Editing src/app.ts" }, { kind: "wait", ms: 4_000 }, { kind: "say", text: "Running tests" }, { kind: "wait", ms: 4_000 }, { kind: "say", text: "done" }] });
  const { result, fc } = await sc.run(testWorkflow([agentNode("n1")]), "n1");
  const out = outputOf(result);
  const live = fc.live();
  assert.equal(live.sessionId, out.sessionId);
  assert.equal(live.selection?.chosen?.accountId, "a1");
  assert.equal(live.hops?.length, 1);
  const lines = fc.updates.map((u) => u.activity).filter(Boolean);
  assert.ok(lines.includes("Editing src/app.ts") && lines.includes("Running tests"), JSON.stringify(lines));
});

test("a host that is restarting (503 on create) is retried on the clock; one session results", async () => {
  const sc = new Scenario({ accounts: CLAUDE });
  sc.host.unavailableCreates = 2;
  const out = outputOf((await sc.run(testWorkflow([agentNode("n1")]), "n1")).result);
  assert.equal(out.text, "Done.");
  assert.equal(sc.host.sessions.size, 1);
});

test("a continue block never implements a plan an earlier block left behind", async () => {
  const sc = new Scenario({
    accounts: CLAUDE,
    behaviour: (t) => (t.turnNumber === 1 ? [{ kind: "plan", markdown: "old plan" }] : [{ kind: "say", text: "follow-up done" }])
  });
  const wf = testWorkflow([agentNode("n1", {}, "Planner"), agentNode("n2", { session: { kind: "continue", fromNode: "Planner" } }, "Doer")]);
  const first = outputOf((await sc.run(wf, "n1")).result);
  const upstreamTurns = sc.host.session(first.sessionId).turns.length;
  const out = outputOf((await sc.run(wf, "n2", { upstream: { Planner: first } })).result);
  assert.equal(out.text, "follow-up done");
  assert.equal(sc.host.session(first.sessionId).turns.length, upstreamTurns + 1, "one follow-up turn, no implementation turn");
});

test("an account the daemon would not launch (gone from its catalogue) is passed over by the catalogue check, never sent", async () => {
  const accounts = [account("claude", "a1"), account("claude", "a2")];
  const sc = new Scenario({
    accounts: [accounts[1]!],
    // Selection's reader still lists a1 (a stale read): the daemon's own catalogue decides.
    accountsReader: { list: () => ({ accounts, defaults: { claude: null, codex: null, grok: null } }) }
  });
  const wf = testWorkflow([agentNode("n1", { chain: [{ agent: "claude", model: "opus", accounts: { strategy: "fixed", includeSystem: false, soonestResetWindow: "weekly", leastUsedMetric: "max", unknownUsage: "last" } }] })]);
  const { result, fc } = await sc.run(wf, "n1");
  const out = outputOf(result);
  assert.equal(out.accountId, "a2");
  const creates = sc.host.calls.filter((c) => c.method === "POST" && c.path === "/api/sessions");
  assert.deepEqual(creates.map((c) => (c.body as { accountId: string }).accountId), ["a2"]);
  assert.ok(fc.live().selection!.skipped.some((s) => s.accountId === "a1" && s.why === "unavailable"));
});

test("a stored chain naming an agent this host does not offer (a removed launcher) passes it over and runs the next entry", async () => {
  const sc = new Scenario({ accounts: [account("claude", "a1")] });
  const policy = { strategy: "least-used" as const, includeSystem: false, soonestResetWindow: "weekly" as const, leastUsedMetric: "max" as const, unknownUsage: "last" as const };
  const wf = testWorkflow([agentNode("n1", { chain: [{ agent: "claudex", model: "gpt-5.5", accounts: policy }, { agent: "claude", model: "opus", accounts: policy }] })]);
  const { result, fc } = await sc.run(wf, "n1");
  const out = outputOf(result);
  assert.equal(out.accountId, "a1");
  const creates = sc.host.calls.filter((c) => c.method === "POST" && c.path === "/api/sessions");
  assert.deepEqual(creates.map((c) => (c.body as { refId: string }).refId), ["claude"]);
  assert.ok(fc.live().selection!.skipped.some((s) => s.agent === "claudex" && s.why === "catalog"));
});
