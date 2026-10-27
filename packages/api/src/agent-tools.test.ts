/**
 * Toolsets (grouping only), tiers and the grant table (unified MCP design 2026-10-15 §7.6, §9.1).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { agentToolsRoutes, grantOptionsFor } from "./agent-tools.ts";

test("grant options: full-access only, never workflow-owned, never cross-project Admin or referenced prompts", () => {
  const base = { callerRuntimeMode: "full-access" as const, workflowOwned: false, crossProject: false };
  assert.deepEqual(grantOptionsFor({ ...base, family: "desktops" }), ["chat", "project"]);
  assert.deepEqual(grantOptionsFor({ ...base, family: "workflows" }), ["chat"]);
  assert.deepEqual(grantOptionsFor({ ...base, family: "agent-profile" }), []);
  assert.deepEqual(grantOptionsFor({ ...base, family: "workflows", crossProject: true }), []);
  assert.deepEqual(grantOptionsFor({ ...base, family: "cross-project", crossProject: true }), ["chat"]);
  assert.deepEqual(grantOptionsFor({ ...base, family: "workflows", workflowReferencedPrompt: true }), []);
  assert.deepEqual(grantOptionsFor({ ...base, family: "desktops", workflowOwned: true }), []);
  for (const mode of ["approval-required", "auto-accept-edits", "auto"] as const) {
    assert.deepEqual(grantOptionsFor({ ...base, family: "desktops", callerRuntimeMode: mode }), [], mode);
  }
});

test("routes", () => {
  assert.equal(agentToolsRoutes.settings, "/api/agent-tools");
  assert.equal(agentToolsRoutes.grants, "/api/agent-tools/grants");
  assert.equal(agentToolsRoutes.grant("g/1"), "/api/agent-tools/grants/g%2F1");
});
