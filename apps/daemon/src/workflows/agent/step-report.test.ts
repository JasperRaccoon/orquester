// The agent block's reporting protocol (spec 2026-11-10 §5.3, §5.4): the protocol block, the one
// reminder turn, `no_report`, the output's report fields and handle — and a daemon restart at every
// step of the reminder, which resumes with the same command ids and never sends a second reminder.

import assert from "node:assert/strict";
import test from "node:test";
import type { AgentChainEntry, WorkflowStepReport } from "@orquester/api";
import type { NodeResult, WaitingOn } from "../contracts.ts";
import type { AgentBlockOutput } from "./executor.ts";
import { reminderMessage, stepProtocolBlock, withStepProtocol } from "./step-report.ts";
import { byAccount, type ProviderStep } from "./testing/fake-chat-host.ts";
import { account, agentNode, testWorkflow } from "./testing/fake-context.ts";
import { Scenario } from "./testing/scenario.ts";

const CLAUDE = [account("claude", "a1", "alpha")];
const OUTCOMES = [
  { id: "approved", label: "Approved", description: "The change is ready." },
  { id: "changes_requested", description: "Something must be fixed." }
];
const OUTPUTS = [
  { name: "pr_url", type: "string" as const, description: "The pull request." },
  { name: "env", type: "enum" as const, values: ["stg", "prd"], required: false }
];

function outputOf(result: NodeResult): AgentBlockOutput {
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  return (result as { output: AgentBlockOutput }).output;
}

function report(sessionId: string, fields: Partial<WorkflowStepReport> = {}): WorkflowStepReport {
  return { outcome: "changes_requested", summary: "Two nits.", outputs: { pr_url: "https://x/1" }, sessionId, reportedAt: "2026-11-10T10:00:00.000Z", ...fields };
}

/** A holder the fake context reads as the engine's stored report, and a step that "calls" the tool. */
function reporting(fields: Partial<WorkflowStepReport> = {}) {
  const holder: { current?: WorkflowStepReport } = {};
  const call = (): ProviderStep => ({ kind: "call", fn: (sessionId) => void (holder.current = report(sessionId, fields)) });
  return { holder, call };
}

test("the protocol block names the outcomes, the outputs and the call to make, after the prompt and before the autonomy note", async () => {
  const { holder, call } = reporting();
  const sc = new Scenario({ accounts: CLAUDE, behaviour: () => [{ kind: "say", text: "Reviewed." }, call()] });
  const wf = testWorkflow([agentNode("n1", { outcomes: OUTCOMES, outputs: OUTPUTS, prompt: { kind: "text", text: "Review the diff." } }, "Review")]);
  outputOf((await sc.run(wf, "n1", { report: holder })).result);
  const input = sc.host.turnLog[0]!.input;
  assert.ok(input.startsWith(`Review the diff.\n\n${stepProtocolBlock({ outcomes: OUTCOMES, outputs: OUTPUTS })}\n\nYou are running unattended`), input);
  const block = stepProtocolBlock({ outcomes: OUTCOMES, outputs: OUTPUTS });
  assert.match(block, /- `approved` \(Approved\): The change is ready\./);
  assert.match(block, /- `changes_requested`: Something must be fixed\./);
  assert.match(block, /- `pr_url` \(a string, required\): The pull request\./);
  assert.match(block, /- `env` \(one of `stg` or `prd`, optional\)/);
  assert.match(block, /Call `report_step_result` once your work is done, as your last action/);
  assert.match(block, /Do not end your turn to wait on background work/);
});

test("a reported outcome: the output gains outcome, summary and outputs, and the block takes its outcome handle", async () => {
  const { holder, call } = reporting();
  const sc = new Scenario({ accounts: CLAUDE, behaviour: () => [call(), { kind: "say", text: "Done." }] });
  const wf = testWorkflow([agentNode("n1", { outcomes: OUTCOMES, outputs: OUTPUTS }, "Review")]);
  const { result, fc } = await sc.run(wf, "n1", { report: holder });
  const out = outputOf(result);
  assert.equal((result as { handle?: string }).handle, "outcome:changes_requested");
  assert.equal(out.text, "Done.", "text stays");
  assert.equal(out.outcome, "changes_requested");
  assert.equal(out.summary, "Two nits.");
  assert.deepEqual(out.outputs, { pr_url: "https://x/1" });
  assert.equal(sc.host.turnLog.length, 1, "no reminder");
  assert.equal(fc.persisted.at(-1), undefined);
});

test("outputs only: a report without an outcome, and the block keeps its success handle", async () => {
  const { holder, call } = reporting({ outcome: undefined });
  const sc = new Scenario({ accounts: CLAUDE, behaviour: () => [call(), { kind: "say", text: "ok" }] });
  const wf = testWorkflow([agentNode("n1", { outputs: OUTPUTS }, "Build")]);
  const { result } = await sc.run(wf, "n1", { report: holder });
  const out = outputOf(result);
  assert.equal((result as { handle?: string }).handle, "success");
  assert.equal("outcome" in out, false);
  assert.deepEqual(out.outputs, { pr_url: "https://x/1" });
});

test("no report: exactly one reminder turn in the same session, which then reports", async () => {
  const { holder, call } = reporting();
  const sc = new Scenario({ accounts: CLAUDE, behaviour: (t) => (t.turnNumber === 1 ? [{ kind: "say", text: "Reviewed, forgot." }] : [call(), { kind: "say", text: "Reported." }]) });
  const wf = testWorkflow([agentNode("n1", { outcomes: OUTCOMES }, "Review")]);
  const { result, fc } = await sc.run(wf, "n1", { report: holder });
  const out = outputOf(result);
  assert.equal(out.outcome, "changes_requested");
  assert.equal(out.text, "Reported.");
  assert.equal(sc.host.sessions.size, 1);
  assert.equal(sc.host.turnLog.length, 2);
  assert.equal(sc.host.turnLog[1]!.sessionId, sc.host.turnLog[0]!.sessionId, "the same session");
  assert.ok(sc.host.turnLog[1]!.input.startsWith(reminderMessage({ outcomes: OUTCOMES })), sc.host.turnLog[1]!.input);
  // The reminder's state was persisted (sending, reminderSent) before its turn was posted.
  const reminderSend = fc.persisted.find((w) => w?.kind === "agent" && w.phase === "sending" && (w.state as { reminderSent?: boolean }).reminderSent === true);
  assert.ok(reminderSend);
});

test("no report after the reminder either: the block fails no_report (retryable), with no third turn", async () => {
  const sc = new Scenario({ accounts: CLAUDE, behaviour: () => [{ kind: "say", text: "I am done." }] });
  const wf = testWorkflow([agentNode("n1", { outcomes: OUTCOMES }, "Review")]);
  const { result, fc } = await sc.run(wf, "n1", { report: {} });
  assert.equal(result.status, "failed");
  const error = (result as { error: { kind: string; message: string } }).error;
  assert.equal(error.kind, "no_report");
  assert.match(error.message, /without calling report_step_result/);
  assert.equal(sc.host.turnLog.length, 2);
  assert.equal(fc.persisted.at(-1), undefined, "the wait is cleared");
});

test("a block without outcomes or outputs is unchanged: no protocol, no reminder, success", async () => {
  const sc = new Scenario({ accounts: CLAUDE, behaviour: () => [{ kind: "say", text: "plain" }] });
  const wf = testWorkflow([agentNode("n1")]);
  const { result } = await sc.run(wf, "n1", { report: {} });
  const out = outputOf(result);
  assert.equal((result as { handle?: string }).handle, undefined);
  assert.equal("outcome" in out || "summary" in out, false);
  assert.equal(sc.host.turnLog.length, 1);
  assert.doesNotMatch(sc.host.turnLog[0]!.input, /report_step_result/);
});

test("a continued session gets the protocol on its follow-up turn", async () => {
  const { holder, call } = reporting();
  const sc = new Scenario({ accounts: CLAUDE, behaviour: (t) => (t.turnNumber === 1 ? [{ kind: "say", text: "written" }] : [call()]) });
  const wf = testWorkflow([
    agentNode("n1", {}, "Writer"),
    agentNode("n2", { session: { kind: "continue", fromNode: "Writer" }, prompt: { kind: "text", text: "Review your work." }, outcomes: OUTCOMES }, "Review")
  ]);
  const first = outputOf((await sc.run(wf, "n1")).result);
  const out = outputOf((await sc.run(wf, "n2", { upstream: { Writer: first }, report: holder })).result);
  assert.equal(out.outcome, "changes_requested");
  assert.ok(sc.host.turnLog[1]!.input.startsWith(withStepProtocol("Review your work.", { outcomes: OUTCOMES })));
});

test("a handoff to another agent carries the protocol into the new session", async () => {
  const { holder, call } = reporting();
  const chain: AgentChainEntry[] = [
    { agent: "claude", model: "opus", accounts: { strategy: "fixed", includeSystem: false, soonestResetWindow: "weekly", leastUsedMetric: "max", unknownUsage: "last" } },
    { agent: "codex", model: "gpt-5", accounts: { strategy: "fixed", includeSystem: false, soonestResetWindow: "weekly", leastUsedMetric: "max", unknownUsage: "last" } }
  ];
  const sc = new Scenario({ accounts: [CLAUDE[0]!, account("codex", "c1")], behaviour: byAccount({ a1: [{ kind: "limit" }], c1: [call(), { kind: "say", text: "codex done" }] }) });
  const wf = testWorkflow([agentNode("n1", { chain, outcomes: OUTCOMES }, "Review")]);
  const out = outputOf((await sc.run(wf, "n1", { report: holder })).result);
  assert.equal(out.agent, "codex");
  assert.equal(out.outcome, "changes_requested");
  const handoff = sc.host.turnLog.at(-1)!.input;
  assert.ok(handoff.includes(stepProtocolBlock({ outcomes: OUTCOMES })), handoff);
});

// --- restart safety -------------------------------------------------------------------------------

type Crash = { phase: string; occurrence?: number; lostAck?: string };

/** A turn that never reports, then a reminder turn that does — crashing at one persist, resuming like the engine. */
async function restartCase(crash: Crash, reportOnReminder: boolean) {
  const holder: { current?: WorkflowStepReport } = {};
  const sc = new Scenario({
    accounts: CLAUDE,
    behaviour: (t) =>
      t.turnNumber === 1 || !reportOnReminder
        ? [{ kind: "say", text: `turn ${t.turnNumber}` }]
        : [{ kind: "call", fn: (sessionId) => void (holder.current = report(sessionId)) }, { kind: "say", text: "reported" }]
  });
  const wf = testWorkflow([agentNode("n1", { outcomes: OUTCOMES }, "Review")]);
  const run = await sc.runWithRestart(wf, "n1", { phase: crash.phase, ...(crash.occurrence !== undefined ? { occurrence: crash.occurrence } : {}) }, {
    extra: { report: holder },
    ...(crash.lostAck
      ? {
          pickResume: (persisted: (WaitingOn | undefined)[]) => {
            // The entry of `lostAck` just before the crashed one: the persist after the side effect never landed.
            const before = persisted.slice(0, -1).reverse().find((w) => w?.kind === "agent" && w.phase === crash.lostAck);
            return before;
          }
        }
      : {})
  });
  assert.equal(run.crashed, true, `crashed at ${crash.phase}#${crash.occurrence ?? 1}`);
  return { sc, run };
}

const RESTARTS: Crash[] = [
  // Settled without a report: the output phase persisted; the reminder had not been decided yet.
  { phase: "output", occurrence: 1 },
  // The reminder's `sending` (reminderSent: true) persisted, its turn not posted yet.
  { phase: "sending", occurrence: 2 },
  // The reminder turn was posted, the `watching` persist after it never landed: re-posted under the same id.
  { phase: "watching", occurrence: 2, lostAck: "sending" },
  // Watching the reminder turn.
  { phase: "watching", occurrence: 2 },
  // The reminder turn settled: its output phase.
  { phase: "output", occurrence: 2 }
];

for (const crash of RESTARTS) {
  test(`restart at ${crash.phase}#${crash.occurrence ?? 1}${crash.lostAck ? ` (lost ${crash.lostAck} ack)` : ""}: one reminder, then the report finishes the block`, async () => {
    const { sc, run } = await restartCase(crash, true);
    const out = outputOf(run.result);
    assert.equal(out.outcome, "changes_requested");
    assert.equal((run.result as { handle?: string }).handle, "outcome:changes_requested");
    assert.equal(sc.host.turnLog.length, 2, "exactly one reminder turn, never a second");
  });

  test(`restart at ${crash.phase}#${crash.occurrence ?? 1}${crash.lostAck ? ` (lost ${crash.lostAck} ack)` : ""}: still no report fails no_report after the one reminder`, async () => {
    const { sc, run } = await restartCase(crash, false);
    assert.equal(run.result.status, "failed");
    assert.equal((run.result as { error: { kind: string } }).error.kind, "no_report");
    assert.equal(sc.host.turnLog.length, 2);
  });
}

test("a report stored before a restart in the output phase finishes the block without a reminder", async () => {
  const { holder, call } = reporting({ outcome: "approved" });
  const sc = new Scenario({ accounts: CLAUDE, behaviour: () => [call(), { kind: "say", text: "ok" }] });
  const wf = testWorkflow([agentNode("n1", { outcomes: OUTCOMES }, "Review")]);
  const run = await sc.runWithRestart(wf, "n1", { phase: "output" }, { extra: { report: holder } });
  assert.equal(run.crashed, true);
  assert.equal(outputOf(run.result).outcome, "approved");
  assert.equal(sc.host.turnLog.length, 1);
});
