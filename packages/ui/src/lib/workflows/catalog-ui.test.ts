import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { nodeSummary, PALETTE_GROUPS } from "./catalog-ui.ts";
import { node } from "./testing.ts";

describe("the gate block in the editor (spec 2026-11-10 §6.1)", () => {
  it("is in the palette's Flow group", () => {
    assert.ok(PALETTE_GROUPS.find((group) => group.id === "flow")?.types.includes("gate"));
  });

  it("its line: the question, else its choices; who decides when it is not the user", () => {
    assert.equal(nodeSummary(node("Gate", "gate")), "Approve / Reject");
    assert.equal(nodeSummary(node("Gate", "gate", { question: "  Deploy\n {{ nodes.Build.output.version }}?" })), "Deploy {{ nodes.Build.output.version }}?");
    const agent = node("Gate", "gate", {
      decider: { kind: "agent", prompt: { kind: "text", text: "" }, chain: [{ agent: "claude", model: "default", accounts: { strategy: "least-used" } }], maxMinutes: 60 }
    });
    assert.equal(nodeSummary(agent, { agentLabel: () => "Claude Code" }), "Claude Code decides · Approve / Reject");
    assert.equal(nodeSummary(node("Gate", "gate", { decider: { kind: "launcher", maxMinutes: 60 }, question: "Ship?" })), "The launching chat decides · Ship?");
    assert.equal(nodeSummary(node("Gate", "gate", { choices: [] })), "No choices yet");
  });
});
