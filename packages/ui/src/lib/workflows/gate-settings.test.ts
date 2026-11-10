import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { GateBlockConfig, WorkflowNodeOf } from "@orquester/api";

import { choiceIdFrom, gateDeciderSummary, gateTimeoutSummary, newChoice, removeChoice, renameChoice } from "./gate-settings.ts";
import { edge, node, workflow } from "./testing.ts";

function gateFlow(timeout?: GateBlockConfig["timeout"]) {
  return workflow(
    [node("T", "trigger.manual"), node("Gate", "gate", timeout ? { timeout } : {}), node("Deploy", "shell"), node("Notify", "http")],
    [edge("T", "Gate"), edge("Gate", "Deploy", "choice:approve"), edge("Gate", "Notify", "choice:reject"), edge("Gate", "Notify", "error")]
  );
}

const gateOf = (flow: ReturnType<typeof gateFlow>) => flow.nodes.find((entry) => entry.id === "Gate") as WorkflowNodeOf<"gate">;

describe("the gate inspector's recipes", () => {
  it("a new choice gets an id no other has", () => {
    assert.deepEqual(newChoice(["approve", "reject"]), { id: "choice_3", label: "Choice 3", comment: "none" });
    assert.equal(newChoice(["a", "choice_2"]).id, "choice_3");
  });

  it("an id from a label", () => {
    assert.equal(choiceIdFrom("Ship it!"), "ship_it");
    assert.equal(choiceIdFrom("2nd try"), "c_2nd_try");
    assert.equal(choiceIdFrom("!!!"), "");
  });

  it("renaming a choice moves its edges and the timeout that takes it", () => {
    const flow = renameChoice(gateFlow({ minutes: 60, then: { kind: "choice", choice: "reject" } }), "Gate", "reject", "decline");
    assert.deepEqual(gateOf(flow).config.choices.map((choice) => choice.id), ["approve", "decline"]);
    assert.deepEqual(gateOf(flow).config.timeout, { minutes: 60, then: { kind: "choice", choice: "decline" } });
    assert.deepEqual(
      flow.edges.filter((entry) => entry.source === "Gate").map((entry) => entry.sourceHandle),
      ["choice:approve", "choice:decline", "error"]
    );
  });

  it("refuses an invalid or used id, and an unknown choice", () => {
    const flow = gateFlow();
    assert.equal(renameChoice(flow, "Gate", "reject", "Approve!"), flow);
    assert.equal(renameChoice(flow, "Gate", "reject", "approve"), flow);
    assert.equal(renameChoice(flow, "Gate", "maybe", "perhaps"), flow);
    assert.equal(renameChoice(flow, "T", "reject", "decline"), flow);
  });

  it("removing a choice removes its edges, nothing else", () => {
    const flow = removeChoice(gateFlow(), "Gate", "reject");
    assert.deepEqual(gateOf(flow).config.choices.map((choice) => choice.id), ["approve"]);
    assert.deepEqual(
      flow.edges.filter((entry) => entry.source === "Gate").map((entry) => entry.sourceHandle),
      ["choice:approve", "error"]
    );
  });

  it("summaries", () => {
    const profile = (id: string | undefined) => (id ? "Reviewer kit" : "Global");
    assert.equal(gateDeciderSummary({ kind: "human" }, profile), "You");
    assert.equal(gateDeciderSummary({ kind: "launcher", maxMinutes: 60 }, profile), "The chat that started the run · at most 1 h, then you");
    assert.equal(
      gateDeciderSummary({ kind: "agent", prompt: { kind: "text", text: "" }, chain: [], maxMinutes: 90, profileId: "p1" }, profile),
      "A reviewer agent · at most 1 h 30 min, then you · Reviewer kit"
    );
    const choices = gateOf(gateFlow()).config.choices;
    assert.equal(gateTimeoutSummary({ choices }), "Fails after 7 days");
    assert.equal(gateTimeoutSummary({ choices, timeout: { minutes: 120, then: { kind: "fail" } } }), "After 2 h: fails");
    assert.equal(gateTimeoutSummary({ choices, timeout: { minutes: 1440, then: { kind: "choice", choice: "reject" } } }), "After 1 day: takes “Reject”");
  });
});
