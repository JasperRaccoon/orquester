/**
 * OpenCode session-tool isolation on a SHARED server (design 2026-10-14
 * §1.2): thread A's model is never offered thread B's tools, and a subagent
 * is offered none.
 *
 * The check below is OpenCode's own, transcribed from the 1.18.34 bundle
 * (`opencode.exe`, the strings around `Permission.disabled`): a tool is
 * dropped from a step when the LAST rule of `merge(agent.permission,
 * session.permission)` whose `permission` wildcard-matches the tool id is a
 * `"*"`-pattern deny; `Wildcard.match` escapes the pattern, maps `*`→`.*` and
 * `?`→`.`, and anchors it. An MCP tool's id is `<server>_<tool>`, each part
 * sanitised to `[a-zA-Z0-9_-]`. A task subagent's session is created with
 * only its parent's DENY rules (and `external_directory`).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildOpenCodePermissionRules, type OpenCodePermissionRuleset } from "./ruleset.ts";
import { openCodeSessionToolsServerName, withSessionToolInstructions, withSessionToolRules } from "./session-tools.ts";

/** OpenCode's `Wildcard.match` (1.18.34). */
function wildcardMatch(text: string, pattern: string): boolean {
  let source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  if (source.endsWith(" .*")) source = `${source.slice(0, -3)}( .*)?`;
  return new RegExp(`^${source}$`, "s").test(text);
}

/** The last rule whose `permission` matches — OpenCode's `findLast` (the daemon's lib target predates it). */
function lastMatching(ruleset: OpenCodePermissionRuleset, permission: string): OpenCodePermissionRuleset[number] | undefined {
  for (let index = ruleset.length - 1; index >= 0; index -= 1) {
    if (wildcardMatch(permission, ruleset[index]!.permission)) return ruleset[index];
  }
  return undefined;
}

/** OpenCode's `Permission.disabled` (1.18.34): the tool ids a step is NOT offered. */
function disabled(tools: readonly string[], ruleset: OpenCodePermissionRuleset): Set<string> {
  const edits = ["edit", "write", "apply_patch"];
  const mcpReads = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];
  return new Set(
    tools.filter((tool) => {
      const permission = edits.includes(tool) ? "edit" : mcpReads.includes(tool) ? "read" : tool;
      const last = lastMatching(ruleset, permission);
      return last?.pattern === "*" && last.action === "deny";
    })
  );
}

/** OpenCode's MCP tool id: `<server>_<tool>`, each sanitised. */
const toolId = (server: string, tool: string): string =>
  `${server.replace(/[^a-zA-Z0-9_-]/g, "_")}_${tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

/** The agent's own rules, as OpenCode's defaults have them: everything allowed. */
const AGENT_RULES: OpenCodePermissionRuleset = [{ permission: "*", pattern: "*", action: "allow" }];

/** What a task subagent's session inherits from its parent (1.18.34's task tool). */
const inheritedBySubagent = (parent: OpenCodePermissionRuleset): OpenCodePermissionRuleset =>
  parent.filter((rule) => rule.permission === "external_directory" || rule.action === "deny");

test("the server name is fixed-width, stable and the thread's own", () => {
  const a = openCodeSessionToolsServerName("thread-a");
  assert.match(a, /^orquester-[0-9a-f]{16}$/);
  assert.equal(openCodeSessionToolsServerName("thread-a"), a);
  assert.notEqual(openCodeSessionToolsServerName("thread-b"), a);
});

for (const mode of ["approval-required", "full-access"] as const) {
  test(`thread A is offered its own tools and never thread B's (${mode})`, () => {
    const serverA = openCodeSessionToolsServerName("thread-a");
    const serverB = openCodeSessionToolsServerName("thread-b");
    const tools = [
      toolId(serverA, "echo"),
      toolId(serverA, "task_status"),
      toolId(serverB, "echo"),
      toolId(serverB, "task_status"),
      "bash",
      "read"
    ];
    const sessionA = withSessionToolRules(buildOpenCodePermissionRules(mode), { serverName: serverA });
    const hiddenFromA = disabled(tools, [...AGENT_RULES, ...sessionA]);
    assert.deepEqual([...hiddenFromA].sort(), [toolId(serverB, "echo"), toolId(serverB, "task_status")].sort());

    // A's own tools resolve to an allow: pre-approved, never asked about.
    const ownRule = lastMatching([...AGENT_RULES, ...sessionA], toolId(serverA, "echo"));
    assert.equal(ownRule?.action, "allow");

    // A's subagent inherits only the deny: it is offered no session tool at all.
    const child = [...AGENT_RULES, ...inheritedBySubagent(sessionA)];
    const hiddenFromChild = disabled(tools, child);
    assert.ok(hiddenFromChild.has(toolId(serverA, "echo")));
    assert.ok(hiddenFromChild.has(toolId(serverB, "echo")));
    assert.ok(!hiddenFromChild.has("bash"), "the subagent's other tools are untouched");
  });
}

test("no thread's allow can reach another's server, whatever their hashes share", () => {
  // Brute force: across many thread ids, A's allow pattern never matches B's tools.
  const names = Array.from({ length: 300 }, (_, index) => openCodeSessionToolsServerName(`thread-${index}`));
  for (const a of names.slice(0, 30)) {
    const allow = `${a}_*`;
    for (const b of names) {
      if (b === a) continue;
      assert.equal(wildcardMatch(toolId(b, "echo"), allow), false, `${a} vs ${b}`);
    }
  }
});

test("without session tools, the ruleset and the system addendum are untouched", () => {
  const rules = buildOpenCodePermissionRules("approval-required");
  assert.equal(withSessionToolRules(rules, undefined), rules);
  assert.equal(withSessionToolInstructions("<runtime_info/>", undefined), "<runtime_info/>");
});
