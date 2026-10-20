/**
 * Toolsets (grouping only), tiers and the grant table (unified MCP design 2026-10-15 §7.6, §9.1).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ADMIN_FAMILIES, APPROVAL_FAMILIES } from "./agent-chat/tool-approvals.ts";
import { SESSION_TOOL_NAME_PATTERN } from "./agent-chat/session-tools.ts";
import { agentToolsRoutes, chatToolNames, GRANT_TABLE, grantOptionsFor, TOOLSET_IDS, TOOLSETS, toolsetOfTool } from "./agent-tools.ts";

test("the catalogue: 54 chat tools in their groups, unique valid names; no switch, no request_toolset", () => {
  const names = chatToolNames();
  assert.equal(names.length, 54);
  assert.equal(new Set(names).size, 54);
  for (const name of names) assert.match(name, SESSION_TOOL_NAME_PATTERN);
  assert.deepEqual(TOOLSETS.map((toolset) => toolset.id), [...TOOLSET_IDS]);
  assert.deepEqual(
    TOOLSETS.map((toolset) => [toolset.id, toolset.tools.length]),
    [["core", 16], ["reads", 5], ["notes", 3], ["chat-extras", 6], ["files-git", 2], ["workflow-authoring", 9], ["agent-profile-editing", 1], ["desktops", 2], ["secret-files", 2], ["boxes", 8]]
  );
  // A group is a label: nothing on it turns its tools on or off.
  for (const toolset of TOOLSETS) assert.deepEqual(Object.keys(toolset).sort(), ["id", "label", "tools"], toolset.id);
  assert.equal(toolsetOfTool("request_toolset"), undefined);
  assert.equal(toolsetOfTool("edit_agent_profile"), "agent-profile-editing");
  assert.equal(toolsetOfTool("thread_send"), undefined);
});

test("tier badges: Admin tools are exactly the ones that can raise an Admin card", () => {
  const admins = TOOLSETS.flatMap((toolset) => toolset.tools.filter((tool) => tool.tier === "admin").map((tool) => tool.name)).sort();
  assert.deepEqual(admins, [
    "control_desktop",
    "create_workflow",
    "delete_workflow",
    "edit_agent_profile",
    "push_secret_files",
    "run_workflow",
    "set_workflow_secret",
    "update_saved_prompts",
    "update_workflow"
  ]);
  assert.ok(!TOOLSETS.find((toolset) => toolset.id === "core")!.tools.some((tool) => tool.tier === "admin"), "core has no Admin tool");
});

test("the grant table: only workflows, desktops, saved prompts and cross-project Act are grantable", () => {
  for (const family of APPROVAL_FAMILIES) assert.ok(Array.isArray(GRANT_TABLE[family]), family);
  assert.deepEqual(GRANT_TABLE.workflows, ["chat"]);
  assert.deepEqual(GRANT_TABLE.desktops, ["chat", "project"]);
  assert.deepEqual(GRANT_TABLE["saved-prompts"], ["chat"]);
  assert.deepEqual(GRANT_TABLE["cross-project"], ["chat"]);
  for (const family of ["agent-profile", "workflow-secrets", "secret-files", "cross-project-read", "cross-workspace-read", "toolset"] as const) {
    // `toolset`: the legacy card family of older builds — never grantable.
    assert.deepEqual(GRANT_TABLE[family], [], family);
  }
  assert.equal(ADMIN_FAMILIES.length, 6);
});

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
  assert.deepEqual(Object.keys(agentToolsRoutes).sort(), ["grant", "grants", "settings"]);
  assert.equal(agentToolsRoutes.grant("g/1"), "/api/agent-tools/grants/g%2F1");
});
