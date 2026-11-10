import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { defaultNodeConfig, outputHandles, validateWorkflow, type AgentBlockConfig, type Workflow } from "@orquester/api";
import { workflowRecordSchema } from "@orquester/config";

import {
  disableOutcomes,
  enableOutcomes,
  moveOutcome,
  newOutcome,
  newOutput,
  parseEnumValues,
  removeOutcome,
  renameOutcome,
  reportSummary,
  toOutcomeId,
  toOutputName,
  withOutputType
} from "./outcomes-edit";

function graph(outcomes?: AgentBlockConfig["outcomes"]): Workflow {
  const agentConfig = { ...(defaultNodeConfig("agent") as AgentBlockConfig), prompt: { kind: "text", text: "Review." }, ...(outcomes ? { outcomes } : {}) };
  return workflowRecordSchema.parse({
    id: "wf",
    name: "W",
    enabled: false,
    revision: 0,
    project: { kind: "existing", projectPath: "/w/ws/app" },
    settings: { timezone: "UTC" },
    nodes: [
      { id: "t", type: "trigger.manual", name: "Start", position: { x: 0, y: 0 }, config: {} },
      { id: "r", type: "agent", name: "Review", position: { x: 0, y: 0 }, config: agentConfig },
      { id: "a", type: "stop", name: "A", position: { x: 0, y: 0 }, config: { as: "success" } },
      { id: "b", type: "stop", name: "B", position: { x: 0, y: 0 }, config: { as: "success" } }
    ],
    edges: [
      { id: "e0", source: "t", sourceHandle: "success", target: "r" },
      { id: "e1", source: "r", sourceHandle: outcomes ? `outcome:${outcomes[0]!.id}` : "success", target: "a" },
      ...(outcomes ? [{ id: "e2", source: "r", sourceHandle: `outcome:${outcomes[1]!.id}`, target: "b" }] : [])
    ],
    createdAt: "2026-11-10T00:00:00.000Z",
    updatedAt: "2026-11-10T00:00:00.000Z"
  });
}

const review = (w: Workflow) => w.nodes.find((n) => n.id === "r")! as Extract<Workflow["nodes"][number], { type: "agent" }>;
const handlesFrom = (w: Workflow) => w.edges.filter((e) => e.source === "r").map((e) => `${e.sourceHandle}→${e.target}`);

describe("outcome and output names as typed", () => {
  it("makes a valid id or refuses", () => {
    assert.equal(toOutcomeId("Changes Requested!"), "changes_requested_");
    assert.equal(toOutcomeId("42 approved"), "approved");
    assert.equal(toOutcomeId("123"), null);
    assert.equal(toOutcomeId(""), null);
    assert.equal(toOutcomeId("x".repeat(50))!.length, 40);
    assert.equal(toOutputName("PR url"), "PR_url");
    assert.equal(toOutputName("_"), null);
  });

  it("mints free ids and names", () => {
    assert.equal(newOutcome([{ id: "outcome" }]).id, "outcome_2");
    assert.deepEqual(newOutput([]), { name: "value", type: "string" });
  });
});

describe("outcome edits carry their connections", () => {
  it("turning outcomes on moves success connections to the first outcome, and the result validates", () => {
    const next = enableOutcomes(graph(), "r");
    assert.deepEqual(review(next).config.outcomes!.map((o) => o.id), ["done", "blocked"]);
    assert.deepEqual(handlesFrom(next), ["outcome:done→a"]);
    assert.deepEqual(validateWorkflow(next).problems.filter((p) => p.severity === "error"), []);
    assert.deepEqual(outputHandles(review(next)), ["outcome:done", "outcome:blocked", "error"]);
  });

  it("turning outcomes off makes the first outcome's connections success ones and drops the rest", () => {
    const next = disableOutcomes(graph([{ id: "approved" }, { id: "rejected" }]), "r");
    assert.equal(review(next).config.outcomes, undefined);
    assert.deepEqual(handlesFrom(next), ["success→a"]);
  });

  it("renaming moves the connections; a colliding or empty id is refused", () => {
    const w = graph([{ id: "approved" }, { id: "rejected" }]);
    const next = renameOutcome(w, "r", 0, "Ship it")!;
    assert.equal(review(next).config.outcomes![0]!.id, "ship_it");
    assert.deepEqual(handlesFrom(next), ["outcome:ship_it→a", "outcome:rejected→b"]);
    assert.equal(renameOutcome(w, "r", 0, "rejected"), null);
    assert.equal(renameOutcome(w, "r", 0, "99"), null);
    assert.equal(renameOutcome(w, "r", 0, "approved"), w);
  });

  it("removing drops its connections (never below two); moving keeps them", () => {
    const three = graph([{ id: "a1" }, { id: "b1" }]);
    const withThird = { ...three, nodes: three.nodes.map((n) => (n.id === "r" ? { ...n, config: { ...(n.config as AgentBlockConfig), outcomes: [{ id: "a1" }, { id: "b1" }, { id: "c1" }] } } : n)) } as Workflow;
    const removed = removeOutcome(withThird, "r", 1);
    assert.deepEqual(review(removed).config.outcomes!.map((o) => o.id), ["a1", "c1"]);
    assert.deepEqual(handlesFrom(removed), ["outcome:a1→a"]);
    assert.equal(removeOutcome(removed, "r", 0), removed, "two is the minimum");
    const moved = moveOutcome(withThird, "r", 0, 1);
    assert.deepEqual(review(moved).config.outcomes!.map((o) => o.id), ["b1", "a1", "c1"]);
    assert.deepEqual(handlesFrom(moved), handlesFrom(withThird));
    assert.equal(moveOutcome(withThird, "r", 0, -1), withThird);
  });
});

describe("outputs", () => {
  it("enum values belong to enums only; text parses into unique values", () => {
    assert.deepEqual(withOutputType({ name: "x", type: "string" }, "enum"), { name: "x", type: "enum", values: ["option"] });
    assert.deepEqual(withOutputType({ name: "x", type: "enum", values: ["a"] }, "number"), { name: "x", type: "number" });
    assert.deepEqual(parseEnumValues("stg, prd\nprd,, dev "), ["stg", "prd", "dev"]);
  });

  it("summarises the block's report", () => {
    assert.equal(reportSummary({}), "No report: one “success” output");
    assert.equal(reportSummary({ outcomes: [{ id: "a", label: "Yes" }, { id: "b" }], outputs: [{ name: "url", type: "string" }] }), "2 outcomes: Yes, b · 1 output: url");
  });
});
