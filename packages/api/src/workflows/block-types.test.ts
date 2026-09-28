import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WORKFLOW_NODE_TYPES, workflowNodeSchema } from "@orquester/config";

import {
  defaultNodeConfig,
  defaultNodeName,
  UNSET_SUBWORKFLOW_ID,
  WORKFLOW_BLOCK_CATALOG,
  WORKFLOW_EXPRESSION_GUIDE
} from "./block-types.ts";
import { WORKFLOW_NODE_CATEGORY, WORKFLOW_NODE_NAME_PATTERN } from "./types.ts";

describe("block catalogue", () => {
  it("covers every type, and every example config is valid", () => {
    for (const type of WORKFLOW_NODE_TYPES) {
      const entry = WORKFLOW_BLOCK_CATALOG[type];
      assert.equal(entry.type, type);
      assert.equal(entry.category, WORKFLOW_NODE_CATEGORY[type]);
      assert.ok(entry.title.length > 0 && entry.description.length > 0 && entry.output.length > 0, type);
      const parsed = workflowNodeSchema.safeParse({ id: "x", name: "X", type, position: { x: 0, y: 0 }, config: entry.example });
      assert.equal(parsed.success, true, `${type}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`);
    }
  });

  it("every default config is valid, and a fresh copy each time", () => {
    for (const type of WORKFLOW_NODE_TYPES) {
      const config = defaultNodeConfig(type);
      const parsed = workflowNodeSchema.safeParse({ id: "x", name: "X", type, position: { x: 0, y: 0 }, config });
      assert.equal(parsed.success, true, `${type}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`);
      assert.deepEqual(parsed.success ? parsed.data.config : null, config, `${type}: the default is already complete`);
      assert.notEqual(defaultNodeConfig(type), config);
    }
    const agent = defaultNodeConfig("agent");
    assert.deepEqual(agent.chain, [
      {
        agent: "claude",
        model: "opus",
        accounts: { strategy: "least-used", includeSystem: false, soonestResetWindow: "weekly", leastUsedMetric: "max", unknownUsage: "last" }
      }
    ]);
    assert.equal(defaultNodeConfig("workflow").workflowId, UNSET_SUBWORKFLOW_ID);
  });
});

describe("defaultNodeName", () => {
  it("names by type, then numbers", () => {
    assert.equal(defaultNodeName("agent", []), "Agent");
    assert.equal(defaultNodeName("agent", ["Agent"]), "Agent2");
    assert.equal(defaultNodeName("agent", ["Agent", "Agent2", "Agent4"]), "Agent3");
    assert.equal(defaultNodeName("trigger.git", []), "GitEvent");
    assert.equal(defaultNodeName("http", ["HTTP"]), "HTTP2");
    for (const type of WORKFLOW_NODE_TYPES) assert.match(defaultNodeName(type, []), WORKFLOW_NODE_NAME_PATTERN);
  });
});

describe("expression guide", () => {
  it("names every root and filter", () => {
    for (const word of ["nodes.", "input", "trigger", "run", "project", "secrets.", "json", "compact", "default(", "trim", "lines(", "first", "last", "length", "upper", "lower", "{diff}", "env"]) {
      assert.ok(WORKFLOW_EXPRESSION_GUIDE.includes(word), word);
    }
  });
});
