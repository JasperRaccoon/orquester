// What a gate tells its agent deciders (spec 2026-11-10 §6.3): literal text survives both agent
// prompt passes unchanged, the question stays a template, and the exact call is named.

import assert from "node:assert/strict";
import { test } from "node:test";

import { renderPromptTemplate, renderTemplate, type WorkflowGateState } from "@orquester/api";

import { launcherMessage, literal, reviewerPrompt, reviewerReminder } from "./prompts.ts";

const gate: WorkflowGateState = {
  gateId: "g-1", runId: "r-1", workflowId: "w1", nodeId: "G", nodeName: "Approve", source: "gate", question: "Ship {v}?",
  details: "## Diff\n{{ not an expression }}",
  choices: [{ id: "approve", label: "Approve {date}", comment: "none" }, { id: "reject", label: "Reject", comment: "required" }],
  decider: { kind: "launcher", label: "the launching chat", sessionId: "chat-1" }, phase: "agent", openedAt: "2026-11-10T12:00:00.000Z", escalated: false
};

const twoPasses = (text: string): string => renderPromptTemplate(renderTemplate(text, { input: null, nodes: {}, trigger: null, run: {}, project: {}, workflow: {}, secrets: {} } as never).text, { date: "2026-11-10", branch: "main" });

test("literal text renders to itself through the {{…}} pass and the {variables} pass", () => {
  for (const text of ["{{ x }} and {{{ y }}}", "{date} {branch} {{date}}", "plain", "\\{{ already }}", '{"runId": "r"}']) {
    assert.equal(twoPasses(literal(text)), text, text);
  }
});

test("the reviewer's prompt keeps its own prompt first, the question as a template, and names the exact call", () => {
  const prompt = reviewerPrompt({ kind: "agent", prompt: { kind: "text", text: "You review." }, chain: [{ agent: "claude", model: "opus", accounts: {} }] as never, maxMinutes: 60 }, { question: "Ship {{ trigger.input.v }}?" }, gate, "Deploy {x}", 45);
  assert.equal(prompt.kind, "text");
  const text = prompt.kind === "text" ? prompt.text : "";
  assert.ok(text.startsWith("You review.\n"));
  assert.ok(text.includes("\nShip {{ trigger.input.v }}?"), "the question template is rendered by the agent block (trust framing)");
  const rendered = twoPasses(text.replace("Ship {{ trigger.input.v }}?", "Ship 1?"));
  assert.match(rendered, /The workflow "Deploy \{x\}" \(run r-1\)/);
  assert.match(rendered, /- `approve`: Approve \{date\}/, "labels stay literal");
  assert.match(rendered, /decide_workflow_gate \{"runId": "r-1", "gateId": "g-1", "choice": "<id>", "comment": "<why>"\}/);
  assert.match(rendered, /You have 45 minutes/);
  const saved = reviewerPrompt({ kind: "agent", prompt: { kind: "saved", promptId: "p1", append: "Be strict." }, chain: [] as never, maxMinutes: 60 }, { question: "Q?" }, gate, "W", 1);
  assert.equal(saved.kind === "saved" && saved.promptId, "p1");
  assert.ok(saved.kind === "saved" && saved.append!.startsWith("Be strict.\n"));
  assert.match(twoPasses(reviewerReminder(gate).kind === "text" ? (reviewerReminder(gate) as { text: string }).text : ""), /one of: approve, reject/);
});

test("the launcher's message is plain text: question, details, choices, the calls and the time left", () => {
  const text = launcherMessage(gate, { workflowName: "Child", rootRunId: "root-1", rootWorkflowName: "Parent", maxMinutes: 30 });
  assert.match(text, /The workflow "Parent" you started \(run root-1\) waits for your decision at the gate "Approve" of its sub-workflow "Child" \(run r-1\)\./);
  assert.match(text, /Question: Ship \{v\}\?/);
  assert.match(text, /## Diff\n\{\{ not an expression \}\}/);
  assert.match(text, /"escalate": true/);
  assert.match(text, /within 30 minutes/);
});
