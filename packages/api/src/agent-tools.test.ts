/**
 * Toolsets, tiers and the grant table (unified MCP design 2026-10-15 §7.6, §9.1), and the
 * catalogue defaults through `@orquester/config`'s resolver.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultAgentToolsFile, resolveThreadToolsets } from "@orquester/config";

import { ADMIN_FAMILIES, APPROVAL_FAMILIES } from "./agent-chat/tool-approvals.ts";
import { SESSION_TOOL_NAME_PATTERN } from "./agent-chat/session-tools.ts";
import {
  agentToolsRoutes,
  AGENT_TOOLS_AGENTS,
  chatToolNames,
  defaultToolsetsFor,
  GRANT_TABLE,
  grantOptionsFor,
  TOOLSET_IDS,
  TOOLSETS,
  toolsetOfTool
} from "./agent-tools.ts";

test("the catalogue is the spec's: 45 chat tools, unique valid names, 22 on by default, core locked", () => {
  const names = chatToolNames();
  assert.equal(names.length, 45);
  assert.equal(new Set(names).size, 45);
  for (const name of names) assert.match(name, SESSION_TOOL_NAME_PATTERN);
  assert.deepEqual(TOOLSETS.map((toolset) => toolset.id), [...TOOLSET_IDS]);
  assert.deepEqual(
    TOOLSETS.map((toolset) => [toolset.id, toolset.tools.length]),
    [["core", 17], ["reads", 5], ["notes", 3], ["chat-extras", 6], ["files-git", 2], ["workflow-authoring", 9], ["agent-profile-editing", 1], ["desktops", 2]]
  );
  assert.deepEqual(TOOLSETS.filter((toolset) => toolset.locked).map((toolset) => toolset.id), ["core"]);
  for (const agent of AGENT_TOOLS_AGENTS) {
    const on = defaultToolsetsFor(agent);
    assert.deepEqual(on, ["core", "reads"], agent);
    assert.equal(TOOLSETS.filter((toolset) => on.includes(toolset.id)).reduce((n, toolset) => n + toolset.tools.length, 0), 22);
    // The config resolver gives the same answer from an empty file.
    assert.deepEqual(resolveThreadToolsets(createDefaultAgentToolsFile(), { threadId: "t", agent, toolsets: TOOLSETS }), on);
  }
  assert.equal(toolsetOfTool("request_toolset"), "core");
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
  for (const family of ["agent-profile", "workflow-secrets", "cross-project-read", "cross-workspace-read", "toolset"] as const) {
    assert.deepEqual(GRANT_TABLE[family], [], family);
  }
  assert.equal(ADMIN_FAMILIES.length, 5);
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
  assert.equal(agentToolsRoutes.updateSettings, "/api/agent-tools/settings");
  assert.equal(agentToolsRoutes.grant("g/1"), "/api/agent-tools/grants/g%2F1");
});
