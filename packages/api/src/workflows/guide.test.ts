import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { toWorkflowAgentCatalog } from "./agent-catalog.ts";
import { outputHandles } from "./graph.ts";
import { WORKFLOW_BLOCK_GUIDES, WORKFLOW_EXPRESSION_RULES, WORKFLOW_RECIPES } from "./guide.ts";
import { createWorkflowFromRequest } from "./patch.ts";
import { sequentialIds } from "./testing.ts";
import { validateWorkflow } from "./validate.ts";

const liveCatalog = toWorkflowAgentCatalog([
  { id: "claude", enabled: true, status: "ready", models: ["default", "opus[1m]", "sonnet"].map((slug) => ({ slug })) }
]);

/** Every secret a published recipe reads must be available to its validation context. */
function secretNamesIn(value: unknown): string[] {
  return [...new Set([...JSON.stringify(value).matchAll(/secrets\.([A-Z][A-Z0-9_]*)/g)].map((match) => match[1]!))];
}

describe("workflow recipes", () => {
  it("every recipe builds and validates with no error and no warning against a live catalogue", () => {
    for (const recipe of WORKFLOW_RECIPES) {
      const workflow = createWorkflowFromRequest(
        {
          name: recipe.title,
          project: { kind: "existing", projectPath: "/w/ws/app" },
          nodes: structuredClone([...recipe.nodes]),
          edges: structuredClone([...recipe.edges])
        },
        { mintId: sequentialIds(), now: new Date("2026-09-28T10:00:00Z") }
      );
      const { problems } = validateWorkflow(workflow, {
        catalog: liveCatalog,
        secretNames: secretNamesIn(recipe.nodes),
        savedPromptIds: [],
        knownWorkflowIds: [workflow.id],
        strictScheduleIntervals: true
      });
      assert.deepEqual(problems.filter((problem) => problem.severity !== "info"), [], recipe.id);
    }
  });

  it("the outcomes recipe branches on the reported outcome, with no Code block to parse a reply", () => {
    const recipe = WORKFLOW_RECIPES.find((entry) => entry.id === "agent-outcomes")!;
    assert.equal(recipe.nodes.some((node) => node.type === "code"), false);
    const triage = recipe.nodes.find((node) => node.name === "Triage")!;
    assert.deepEqual(outputHandles({ id: "x", type: "agent", config: triage.config }), ["outcome:high", "outcome:low", "error"]);
    assert.deepEqual(recipe.edges.filter((edge) => edge.source === "Triage").map((edge) => edge.sourceHandle), ["outcome:high", "outcome:low"]);
  });

  it("the worked loop recipe is fix → review → loop back on changes_requested → a person's gate before merge", () => {
    const recipe = WORKFLOW_RECIPES.find((entry) => entry.id === "loop-until-approved")!;
    const loops = recipe.edges.filter((edge) => edge.loop !== undefined);
    assert.deepEqual(loops, [{ source: "Review", sourceHandle: "outcome:changes_requested", target: "Fix", loop: { maxLoops: 3, session: "continue" } }]);
    const gate = recipe.nodes.find((node) => node.type === "gate")!;
    assert.deepEqual(outputHandles({ id: "x", type: "gate", config: gate.config }), ["choice:approve", "choice:reject", "error"]);
    assert.deepEqual(recipe.edges.filter((edge) => edge.source === "Review" && edge.loop === undefined).map((edge) => [edge.sourceHandle, edge.target]), [["outcome:approved", gate.name]]);
    assert.deepEqual(recipe.edges.filter((edge) => edge.source === gate.name).map((edge) => edge.sourceHandle), ["choice:approve", "choice:reject"]);
  });

  it("no guide text still tells an agent to parse a reply in a Code block", () => {
    const text = JSON.stringify({ WORKFLOW_BLOCK_GUIDES, WORKFLOW_EXPRESSION_RULES, WORKFLOW_RECIPES });
    assert.doesNotMatch(text, /parse it in a Code block/i);
    assert.doesNotMatch(text, /JSON\.parse/);
  });
});
