// The MCP authoring guide names only real things: block types, tools, patch ops, error and problem codes,
// {{ }} roots and filters, the Code signature and every recipe (the shared facts are held to the engine by
// packages/api guide.test.ts; the e2e tests run the recipes and the Code contract for real).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { parseTemplate, WORKFLOW_CODE_SIGNATURE, WORKFLOW_EXPRESSION_GUIDE, WORKFLOW_RECIPES, type WorkflowBlockErrorKind } from "@orquester/api";
import { WORKFLOW_NODE_TYPES } from "@orquester/config";

import { catalogTools } from "./catalog.ts";
import { WORKFLOW_AUTHORING_GUIDE } from "./workflows-guide.ts";
import { workflowTools } from "./workflows.ts";

const apiSource = (file: string): string => readFileSync(new URL(`../../../../../packages/api/src/workflows/${file}`, import.meta.url), "utf8");

test("the Code rule quotes the shared signature", () => {
  assert.ok(WORKFLOW_AUTHORING_GUIDE.includes(WORKFLOW_CODE_SIGNATURE));
});

test("every block type the guide names exists", () => {
  const named = [
    ...[...WORKFLOW_AUTHORING_GUIDE.matchAll(/"type":"([^"]+)"/g)].map((match) => match[1]!),
    ...[...WORKFLOW_AUTHORING_GUIDE.matchAll(/^### ([a-z.]+) \(/gm)].map((match) => match[1]!)
  ];
  assert.ok(named.length > 20, "the scan found the types");
  for (const type of named) assert.ok((WORKFLOW_NODE_TYPES as readonly string[]).includes(type), type);
});

test("every {{ }} in the guides parses: real roots and filters", () => {
  let count = 0;
  for (const text of [WORKFLOW_AUTHORING_GUIDE, WORKFLOW_EXPRESSION_GUIDE]) {
    for (const match of text.matchAll(/(\\?)\{\{([^{}]*)\}\}/g)) {
      const body = match[2]!.trim();
      // Escapes, placeholders (…, <Name>) and the syntax written about (`{{ path | filter }}`, `{{name}}`).
      if (match[1] === "\\" || body.length === 0 || body.includes("…") || body.includes("<") || body === "path | filter" || body === "name") continue;
      count += 1;
      assert.deepEqual(parseTemplate(`{{ ${body.replace(/\\"/g, "\"")} }}`).errors, [], body);
    }
  }
  assert.ok(count > 40, `only ${count} expressions found`);
});

test("every snake_case name in the guide is a tool, a patch op, an error kind or a problem code", () => {
  const tools = new Set([...workflowTools, ...catalogTools].map((tool) => tool.name));
  const ops = new Set([...apiSource("patch.ts").matchAll(/case "([a-z]+(?:_[a-z]+)+)":/g)].map((match) => match[1]!));
  const problemCodes = new Set([...apiSource("validate.ts").matchAll(/code: "([a-z_]+)"/g)].map((match) => match[1]!));
  const errorKinds: Record<WorkflowBlockErrorKind, true> = {
    all_burnt: true, agent_error: true, timeout: true, cancelled: true, interrupted: true, exit_code: true, exception: true,
    http_status: true, network: true, expression: true, validation: true, project_missing: true, child_run_failed: true,
    stopped: true, limit_exceeded: true, internal: true
  };
  // Fields of third-party data a recipe's code reads.
  const dataFields = new Set(["tag_name"]);
  assert.ok(ops.has("add_node") && ops.has("set_enabled"), "the op scan found the ops");
  const named = new Set([...WORKFLOW_AUTHORING_GUIDE.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map((match) => match[0]));
  for (const name of named) {
    assert.ok(tools.has(name) || ops.has(name) || name in errorKinds || problemCodes.has(name) || dataFields.has(name), `unknown name "${name}"`);
  }
  assert.ok(named.has("preview_expression"), "the guide points at preview_expression");
});

test("every recipe is in the guide, as copy-pasteable JSON", () => {
  for (const recipe of WORKFLOW_RECIPES) {
    assert.ok(WORKFLOW_AUTHORING_GUIDE.includes(`### ${recipe.title}`), recipe.id);
    assert.ok(WORKFLOW_AUTHORING_GUIDE.includes(JSON.stringify({ nodes: recipe.nodes, edges: recipe.edges })), recipe.id);
  }
});
