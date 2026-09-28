// Resumability (spec §5.8): a daemon restart at EVERY phase of the agent block — the executor
// persisted its WaitingOn and died before (or right after) the side effect — resumes correctly with a
// new executor, and a re-posted command is deduplicated by the host's receipts (same commandId).

import assert from "node:assert/strict";
import test from "node:test";
import type { AgentChainEntry } from "@orquester/api";
import type { NodeResult, WaitingOn } from "../contracts.ts";
import { AGENT_PHASES, type AgentBlockOutput, type AgentPhase } from "./executor.ts";
import { byAccount, type FakeBehaviour } from "./testing/fake-chat-host.ts";
import { account, agentNode, testWorkflow } from "./testing/fake-context.ts";
import { Scenario } from "./testing/scenario.ts";

const FIXED = { strategy: "fixed", includeSystem: false, soonestResetWindow: "weekly", leastUsedMetric: "max", unknownUsage: "last" } as const;
const CLAUDE = [account("claude", "a1", "alpha"), account("claude", "a2", "beta")];
const CODEX = [account("codex", "c1", "cx-one")];
const HOUR = 60 * 60_000;

function outputOf(result: NodeResult): AgentBlockOutput {
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  return (result as { output: AgentBlockOutput }).output;
}

type Kind = "plain" | "question" | "switch" | "handoff" | "reset";

interface Case {
  kind: Kind;
  phase: AgentPhase;
  occurrence?: number;
  /** Resume from the entry BEFORE the crashed one: the crash lost the persist that followed the side effect. */
  lostAck?: AgentPhase;
}

function setup(kind: Kind): { sc: Scenario; wf: ReturnType<typeof testWorkflow>; expectText: string; expectSessions: number } {
  if (kind === "plain") {
    const sc = new Scenario({ accounts: CLAUDE, behaviour: () => [{ kind: "wait", ms: 3_000 }, { kind: "say", text: "plain done" }] });
    return { sc, wf: testWorkflow([agentNode("n1")]), expectText: "plain done", expectSessions: 1 };
  }
  if (kind === "question") {
    const sc = new Scenario({
      accounts: CLAUDE,
      behaviour: () => [{ kind: "ask", questions: [{ id: "q", header: "Q", question: "Which?", options: [{ label: "x", description: "" }] }] }, { kind: "say", text: "answered" }]
    });
    return { sc, wf: testWorkflow([agentNode("n1")]), expectText: "answered", expectSessions: 1 };
  }
  if (kind === "switch") {
    const behaviour: FakeBehaviour = byAccount({ a1: [{ kind: "say", text: "half" }, { kind: "wait", ms: 5_000 }, { kind: "limit" }], a2: [{ kind: "say", text: "switched done" }] });
    const sc = new Scenario({ accounts: CLAUDE, behaviour });
    return { sc, wf: testWorkflow([agentNode("n1")]), expectText: "switched done", expectSessions: 1 };
  }
  if (kind === "handoff") {
    const sc = new Scenario({ accounts: [CLAUDE[0]!, ...CODEX], behaviour: byAccount({ a1: [{ kind: "limit" }], c1: [{ kind: "say", text: "codex done" }] }) });
    const chain: AgentChainEntry[] = [
      { agent: "claude", model: "opus", accounts: { ...FIXED } },
      { agent: "codex", model: "gpt-5", accounts: { ...FIXED } }
    ];
    return { sc, wf: testWorkflow([agentNode("n1", { chain })]), expectText: "codex done", expectSessions: 2 };
  }
  const sc = new Scenario({ accounts: [CLAUDE[0]!], behaviour: () => [] });
  const resetsAt = new Date(sc.clock.now().getTime() + 2 * HOUR).toISOString();
  let n = 0;
  sc.host.behaviour = () => (++n === 1 ? [{ kind: "limit", resetsAt }] : [{ kind: "say", text: "after reset" }]);
  return { sc, wf: testWorkflow([agentNode("n1", { whenAllBurnt: { kind: "wait-for-reset", maxWaitHours: 4 } })]), expectText: "after reset", expectSessions: 1 };
}

const CASES: Case[] = [
  { kind: "plain", phase: "selecting" },
  { kind: "plain", phase: "creating" },
  { kind: "plain", phase: "sending" },
  { kind: "plain", phase: "watching" },
  { kind: "plain", phase: "output" },
  // The create's answer is lost: the session exists, the persist naming it never landed.
  { kind: "plain", phase: "sending", lostAck: "creating" },
  // The turn was posted, the persist of `watching` never landed: the re-post is deduplicated.
  { kind: "plain", phase: "watching", lostAck: "sending" },
  { kind: "question", phase: "answering" },
  { kind: "question", phase: "watching", occurrence: 2, lostAck: "answering" },
  { kind: "switch", phase: "interrupting" },
  { kind: "switch", phase: "waiting-idle" },
  { kind: "switch", phase: "failing-over" },
  { kind: "switch", phase: "switching" },
  { kind: "switch", phase: "sending", occurrence: 2, lostAck: "switching" },
  { kind: "switch", phase: "sending", occurrence: 2 },
  { kind: "switch", phase: "watching", occurrence: 2 },
  { kind: "handoff", phase: "handing-off" },
  { kind: "handoff", phase: "creating", occurrence: 2 },
  { kind: "handoff", phase: "sending", occurrence: 2, lostAck: "creating" },
  { kind: "reset", phase: "waiting-reset" },
  { kind: "reset", phase: "failing-over", occurrence: 2 },
  { kind: "reset", phase: "sending", occurrence: 2 }
];

test("every phase of the vocabulary is covered by a restart case", () => {
  const covered = new Set(CASES.map((c) => c.phase));
  for (const phase of AGENT_PHASES) assert.ok(covered.has(phase), `no restart case for ${phase}`);
});

for (const c of CASES) {
  const name = `restart at ${c.phase}${c.occurrence ? ` #${c.occurrence}` : ""} (${c.kind})${c.lostAck ? `, the ack after ${c.lostAck} lost` : ""}`;
  test(name, async () => {
    const { sc, wf, expectText, expectSessions } = setup(c.kind);
    const run = await sc.runWithRestart(wf, "n1", { phase: c.phase, ...(c.occurrence ? { occurrence: c.occurrence } : {}) }, {
      ...(c.lostAck
        ? {
            pickResume: (persisted: (WaitingOn | undefined)[]) =>
              [...persisted].reverse().find((p): p is WaitingOn => p?.kind === "agent" && p.phase === c.lostAck)
          }
        : {})
    });
    assert.equal(run.crashed, true, "the scenario reached the phase");
    const out = outputOf(run.result);
    assert.equal(out.text, expectText);
    assert.equal(sc.host.sessions.size, expectSessions, "no session created twice");
    // Every command reached the provider once: a re-post under the same id is deduplicated.
    for (const session of sc.host.sessions.values()) {
      const applied = session.commands.filter((cmd) => !cmd.deduped);
      const ids = applied.map((cmd) => cmd.body.commandId);
      assert.equal(new Set(ids).size, ids.length, "no command applied twice");
      const userTurns = session.turns.filter((t) => t.userMessageId !== undefined || t.turnId === null);
      assert.equal(userTurns.length, applied.filter((cmd) => cmd.name === "turn").length);
    }
    if (c.lostAck) {
      const deduped = [...sc.host.sessions.values()].flatMap((s) => s.commands.filter((cmd) => cmd.deduped));
      if (c.lostAck !== "creating") assert.ok(deduped.length >= 1, "the re-post was deduplicated by its commandId");
    }
    assert.equal(run.second!.persisted.at(-1), undefined, "the resumed run clears its waitingOn");
  });
}

test("a re-posted turn reuses the persisted commandId and is deduplicated by the host's receipts", async () => {
  const { sc, wf } = setup("plain");
  const run = await sc.runWithRestart(wf, "n1", { phase: "watching" }, {
    pickResume: (persisted) => persisted.find((p): p is WaitingOn => p?.kind === "agent" && p.phase === "sending")
  });
  outputOf(run.result);
  const session = [...sc.host.sessions.values()][0]!;
  const turns = session.commands.filter((cmd) => cmd.name === "turn");
  assert.equal(turns.length, 2, "posted twice");
  assert.equal(turns[0]!.body.commandId, turns[1]!.body.commandId, "under one commandId");
  assert.equal(turns[1]!.deduped, true);
  assert.equal(session.turns.length, 1, "one turn");
  assert.equal(run.resumedFrom!.kind, "agent");
  const resumed = run.resumedFrom as Extract<WaitingOn, { kind: "agent" }>;
  assert.equal(resumed.command, "turn");
  assert.equal(resumed.commandId, turns[0]!.body.commandId);
  assert.ok(resumed.baseline, "the baseline is persisted with the command");
});

test("a persisted state this version cannot read ends the block interrupted", async () => {
  const { sc, wf } = setup("plain");
  const fc = sc.context(wf, "n1", {
    resumeFrom: { kind: "agent", sessionId: "", commandId: "", command: "turn", baseline: null, deadlineAt: new Date().toISOString(), phase: "weird", state: { v: 99 } }
  });
  const result = await sc.clock.drive(sc.executor().execute(fc.ctx));
  assert.equal(result.status, "failed");
  assert.equal((result as { error: { kind: string } }).error.kind, "interrupted");
});

test("the deadline is wall-clock: a resumed block does not get its maxMinutes again", async () => {
  const sc = new Scenario({ accounts: CLAUDE, behaviour: () => [{ kind: "hang" }] });
  const wf = testWorkflow([agentNode("n1", { maxMinutes: 30 })]);
  const start = sc.clock.now().getTime();
  const run = await sc.runWithRestart(wf, "n1", { phase: "watching" });
  assert.equal((run.result as { error: { kind: string } }).error.kind, "timeout");
  const took = sc.clock.now().getTime() - start;
  assert.ok(took < 31 * 60_000, `took ${took}`);
});

// Secrets (§5.7): the state the block persists (WaitingOn → run.json, unredacted) never holds a
// secret's value — only its marker; the POSTed body carries the real value, a resumed send too.
const SECRET = "tok-9f8e7d6c5b4a";
const SECRET_WF = () =>
  testWorkflow([agentNode("n1", { prompt: { kind: "text", text: "Deploy with token {{ secrets.API_TOKEN }} now." } })]);

for (const phase of ["creating", "sending"] as const) {
  test(`a secret in the prompt is never persisted, and a restart at ${phase} still sends the real value`, async () => {
    const sc = new Scenario({ accounts: CLAUDE, behaviour: () => [{ kind: "say", text: "deployed" }] });
    const run = await sc.runWithRestart(SECRET_WF(), "n1", { phase }, { extra: { secrets: { API_TOKEN: SECRET } } });
    assert.equal(run.crashed, true);
    assert.equal(outputOf(run.result).text, "deployed");
    for (const persisted of [...run.first.persisted, ...run.second!.persisted]) {
      assert.ok(!JSON.stringify(persisted ?? null).includes(SECRET), `persisted state holds the secret: ${JSON.stringify(persisted)}`);
    }
    const sent = sc.host.turnLog.map((t) => t.input);
    assert.equal(sent.length, 1);
    assert.ok(sent[0]!.startsWith(`Deploy with token ${SECRET} now.`), sent[0]);
    assert.ok(!sent[0]!.includes(""), "no marker reaches the agent");
  });
}

test("a handoff prompt carrying the secret keeps it out of the state and sends the real value", async () => {
  const sc = new Scenario({ accounts: [CLAUDE[0]!, ...CODEX], behaviour: byAccount({ a1: [{ kind: "limit" }], c1: [{ kind: "say", text: "codex done" }] }) });
  const chain: AgentChainEntry[] = [
    { agent: "claude", model: "opus", accounts: { ...FIXED } },
    { agent: "codex", model: "gpt-5", accounts: { ...FIXED } }
  ];
  const wf = testWorkflow([agentNode("n1", { chain, prompt: { kind: "text", text: "Use {{ secrets.API_TOKEN }}." } })]);
  const run = await sc.runWithRestart(wf, "n1", { phase: "creating", occurrence: 2 }, { extra: { secrets: { API_TOKEN: SECRET } } });
  assert.equal(outputOf(run.result).text, "codex done");
  for (const persisted of [...run.first.persisted, ...run.second!.persisted]) assert.ok(!JSON.stringify(persisted ?? null).includes(SECRET));
  const handoff = sc.host.turnLog.find((t) => t.refId === "codex")!.input;
  assert.ok(handoff.startsWith(`Use ${SECRET}.`), handoff);
});
