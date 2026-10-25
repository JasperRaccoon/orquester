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

import { catalogFor } from "../../../mcp/catalog/index.ts";
import { buildOpenCodePermissionRules, type OpenCodePermissionRuleset } from "./ruleset.ts";
import { openCodeSessionToolsServerName, withSessionToolRules } from "./session-tools.ts";

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

/** The name `docs/orquester-mcp.md` suggests for the external `/mcp` inside a chat-capable CLI. */
const SUGGESTED_EXTERNAL_NAME = "orquester_remote";

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
    const sessionA = withSessionToolRules(buildOpenCodePermissionRules(mode), { isolate: true, own: { serverName: serverA } });
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

test("every tool of a denied server is dropped, its own tools kept (§12.1)", () => {
  const own = openCodeSessionToolsServerName("thread-a");
  const session = withSessionToolRules(buildOpenCodePermissionRules("full-access"), { isolate: true, own: { serverName: own }, deny: ["orquester", "remote.api"] });
  const tools = [toolId(own, "echo"), toolId("orquester", "send_message"), toolId("remote_api", "list"), toolId("github", "issue"), "bash"];
  const hidden = disabled(tools, [...AGENT_RULES, ...session]);
  assert.deepEqual([...hidden].sort(), [toolId("orquester", "send_message"), toolId("remote_api", "list")].sort());
  // The denials come last, so nothing above re-allows them.
  assert.deepEqual(session.slice(-2).map((rule) => [rule.permission, rule.action]), [["orquester_*", "deny"], ["remote_api_*", "deny"]]);
});

test("a thread whose own grant failed is still kept off every co-tenant's tools", () => {
  const serverA = openCodeSessionToolsServerName("thread-a");
  const tools = [toolId(serverA, "echo"), "bash"];
  const sessionC = withSessionToolRules(buildOpenCodePermissionRules("full-access"), { isolate: true });
  const hidden = disabled(tools, [...AGENT_RULES, ...sessionC]);
  assert.deepEqual([...hidden], [toolId(serverA, "echo")]);
});

test("the external /mcp under the name docs/orquester-mcp.md suggests keeps every tool", () => {
  const serverA = openCodeSessionToolsServerName("thread-a");
  const session = withSessionToolRules(buildOpenCodePermissionRules("full-access"), { isolate: true, own: { serverName: serverA } });
  const offered = (server: string) =>
    disabled(catalogFor("external").map((tool) => toolId(server, tool.name)), [...AGENT_RULES, ...session]);
  // The suggested name, and the guide's own `orquester`, can never meet the
  // deny's literal `orquester-` prefix.
  assert.deepEqual([...offered(SUGGESTED_EXTERNAL_NAME)], []);
  assert.deepEqual([...offered("orquester")], []);
  // Why the guide does not suggest `orquester-remote`: the deny's 16 `?` can
  // land on a `_` inside such a server's tool names (documented limitation).
  assert.ok(offered("orquester-remote").size > 0);
});
