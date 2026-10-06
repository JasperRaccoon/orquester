import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

import { toWorkflowAgentCatalog } from "./agent-catalog.ts";
import { WORKFLOW_RECIPES } from "./guide.ts";
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

/** The module's default export as a callable, in a fresh VM context (the sandbox's ESM, minus the `export`). */
function loadDefaultExport(source: string): (arg: Record<string, unknown>) => Promise<unknown> {
  const context: Record<string, unknown> = {};
  runInNewContext(source.replace(/\bexport\s+default\s+/, "globalThis.main = "), context);
  return context.main as (arg: Record<string, unknown>) => Promise<unknown>;
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

  it("the JSON-parsing recipe turns an agent's chatty reply into an object, and throws on a reply without JSON", async () => {
    const parse = WORKFLOW_RECIPES.find((recipe) => recipe.id === "agent-json")!.nodes.find((node) => node.name === "Parse")!;
    const main = loadDefaultExport((parse.config as { source: string }).source);
    // The VM's objects come from another realm: compare their JSON.
    assert.equal(JSON.stringify(await main({ input: { text: "Sure:\n{\"severity\": \"high\", \"summary\": \"disk full\"}" } })), "{\"severity\":\"high\",\"summary\":\"disk full\"}");
    await assert.rejects(main({ input: { text: "no idea" } }));
  });
});
