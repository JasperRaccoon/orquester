/**
 * The per-thread manifest (unified MCP design 2026-10-15 §9.4, §12.1, spec §14.2.5): every chat
 * tool (none always-Admin for a workflow-owned chat), the instruction block, and the deny list per
 * thread (agent, account home, project).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { DaemonPointingServer } from "@orquester/api";
import { z } from "zod";

import { defineTool, READ_ONLY, type AnyOrquesterTool, type Tier, type ToolsetId } from "../mcp/catalog/contract.ts";
import { catalogFor } from "../mcp/catalog/index.ts";
import { composeOrquesterInstructions } from "./instructions.ts";
import { advertisedChatTools, buildSessionToolsManifest, denyFor, type ManifestThread } from "./manifest.ts";

const tool = (name: string, toolset: ToolsetId, tier: Tier | ((args: Record<string, unknown>) => Tier)): AnyOrquesterTool =>
  defineTool({
    name,
    title: name,
    description: name,
    input: { x: z.string().optional() },
    audiences: ["chat"],
    toolset,
    tier,
    ...(tier === "admin" || typeof tier === "function"
      ? { adminFamily: "workflows" as const, approval: async () => ({ title: name, scopeLabel: name, sections: [] }) }
      : {}),
    scope: async () => ({ projects: [], sessions: [], reads: "none", writes: false, causesTurnIn: [] }),
    annotations: READ_ONLY,
    resultKind: "json",
    run: async () => ({})
  }) as AnyOrquesterTool;

const CATALOG = [
  tool("list_sessions", "core", "read"),
  tool("list_workflows", "reads", "read"),
  tool("update_todos", "notes", "act"),
  tool("create_workflow", "workflow-authoring", "admin"),
  tool("update_saved_prompts", "notes", (args) => (args.x ? "admin" : "act"))
];

const thread = (over: Partial<ManifestThread> = {}): ManifestThread => ({
  agentId: "claude",
  home: "acct-1",
  projectPaths: ["/w/acme/api"],
  workflowOwned: false,
  ...over
});

const server = (over: Partial<DaemonPointingServer>): DaemonPointingServer => ({
  agent: "claude",
  home: "acct-1",
  scope: "user",
  name: "orquester_remote",
  reason: "bearer",
  ...over
});

test("every chat is advertised every chat tool, in catalog order, whatever its group", () => {
  assert.deepEqual(advertisedChatTools(CATALOG, false), ["list_sessions", "list_workflows", "update_todos", "create_workflow", "update_saved_prompts"]);
});

test("a workflow-owned chat is advertised no always-Admin tool; per-call tiers stay (the gate refuses their Admin calls)", () => {
  assert.deepEqual(advertisedChatTools(CATALOG, true), ["list_sessions", "list_workflows", "update_todos", "update_saved_prompts"]);
});

test("deny: the thread's agent, in its own account home or its project — exactly what its CLI loads", () => {
  const servers = [
    server({ name: "orquester_remote" }),
    server({ name: "other_home", home: "acct-2" }),
    server({ name: "codex_one", agent: "codex" }),
    server({ name: "here", scope: "project", projectPath: "/w/acme/api/" }),
    server({ name: "elsewhere", scope: "project", projectPath: "/w/acme/web" }),
    server({ name: "orquester", reason: "name" }),
    server({ name: "orquester_remote", reason: "url" })
  ];
  assert.deepEqual(denyFor(thread(), servers), ["here", "orquester", "orquester_remote"]);
  assert.deepEqual(denyFor(thread({ home: "system" }), [server({ home: "system", name: "sys" })]), ["sys"]);
  // A thread bound to no project matches no project-level server.
  assert.deepEqual(denyFor(thread({ projectPaths: [] }), [server({ name: "here", scope: "project", projectPath: "/w/acme/api" })]), []);
  // The canonical spelling counts too.
  assert.deepEqual(denyFor(thread({ projectPaths: ["/w/acme/api-link", "/w/acme/api"] }), [server({ name: "p", scope: "project", projectPath: "/w/acme/api" })]), ["p"]);
});

test("deny: a chat in a directory inside its project — the configs from the root down to its cwd, never a sibling's or a deeper one's", () => {
  const servers = [
    server({ name: "root", scope: "project", projectPath: "/w/acme/api" }),
    server({ name: "on_the_way", scope: "project", projectPath: "/w/acme/api/packages" }),
    server({ name: "at_cwd", scope: "project", projectPath: "/w/acme/api/packages/app/" }),
    server({ name: "deeper", scope: "project", projectPath: "/w/acme/api/packages/app/src" }),
    server({ name: "sibling", scope: "project", projectPath: "/w/acme/api/docs" }),
    server({ name: "outside", scope: "project", projectPath: "/w/acme" }),
    server({ name: "other_project", scope: "project", projectPath: "/w/acme/web" })
  ];
  // An ancestor of the project counts (Codex reads from its project root — the git root, maybe above).
  assert.deepEqual(denyFor(thread({ cwdPaths: ["/w/acme/api/packages/app"] }), servers), ["at_cwd", "on_the_way", "outside", "root"]);
  assert.deepEqual(denyFor(thread(), servers), ["outside", "root"], "at the project root: the root's and its ancestors'");
});

test("deny: a Codex project server in every home — trust (`loadedByHomes`) is display only", () => {
  const codex = (loadedByHomes?: string[]) => server({ agent: "codex", home: "system", scope: "project", projectPath: "/w/acme/api", name: "proj", ...(loadedByHomes ? { loadedByHomes } : {}) });
  for (const loadedByHomes of [["acct-1"], [], undefined]) {
    assert.deepEqual(denyFor(thread({ agentId: "codex", home: "system" }), [codex(loadedByHomes)]), ["proj"]);
  }
});

test("deny: a chat whose cwd or project leaves its bounds — every server of its agent known anywhere", () => {
  const servers = [
    server({ name: "other_home", home: "acct-2" }),
    server({ name: "other_project", scope: "project", projectPath: "/w/acme/web" }),
    server({ name: "codex_one", agent: "codex" })
  ];
  assert.deepEqual(denyFor(thread({ denyEveryKnown: true }), servers), ["other_home", "other_project"], "its own agent's only");
  assert.deepEqual(denyFor(thread(), servers), []);
});

test("deny: a server every home of the agent loads (Grok's inherited ~/.claude.json, allHomes) is denied in an account home too", () => {
  const inherited = server({ agent: "grok", home: "system", name: "claude_inherited", allHomes: true });
  const ownConfig = server({ agent: "grok", home: "system", name: "grok_system_only" });
  assert.deepEqual(denyFor(thread({ agentId: "grok", home: "acct-g" }), [inherited, ownConfig]), ["claude_inherited"]);
  assert.deepEqual(denyFor(thread({ agentId: "grok", home: "system" }), [inherited, ownConfig]), ["claude_inherited", "grok_system_only"]);
  assert.deepEqual(denyFor(thread({ agentId: "claude", home: "acct-g" }), [inherited]), [], "only the agent it is reported under");
});

test("the manifest: tools, the composed block and the deny list; no legacy toolsets field", () => {
  const manifest = buildSessionToolsManifest({ thread: thread({ workflowOwned: true }), catalog: CATALOG, daemonPointing: [server({})] });
  assert.deepEqual(manifest.tools, ["list_sessions", "list_workflows", "update_todos", "update_saved_prompts"]);
  assert.deepEqual(manifest.deny, ["orquester_remote"]);
  assert.equal(manifest.toolsets, undefined);
  assert.equal(manifest.instructions, composeOrquesterInstructions({ workflowOwned: true }));
});

test("the production catalog: a fresh chat of any agent, with nothing configured, is advertised every chat tool", () => {
  const chat = catalogFor("chat");
  // boxes: the box tools only while a box can be rented.
  const withoutBoxes = chat.filter((t) => t.toolset !== "boxes");
  for (const agentId of ["claude", "codex", "grok", "opencode"] as const) {
    const manifest = buildSessionToolsManifest({ thread: thread({ agentId }), catalog: chat, daemonPointing: [] });
    assert.deepEqual(manifest.tools, withoutBoxes.map((t) => t.name), agentId);
    const renting = buildSessionToolsManifest({ thread: thread({ agentId }), catalog: chat, daemonPointing: [], boxesAvailable: true });
    assert.deepEqual(renting.tools, chat.map((t) => t.name), agentId);
  }
  // A workflow-owned chat may rent a box too (its card waits for the owner): create_box is not Admin.
  const ownedRenting = buildSessionToolsManifest({ thread: thread({ workflowOwned: true }), catalog: chat, daemonPointing: [], boxesAvailable: true }).tools;
  for (const name of ["create_box", "box_exec", "destroy_box"]) assert.ok(ownedRenting.includes(name), name);
  // Formerly off-by-default groups are in it, and request_toolset is gone.
  const tools = buildSessionToolsManifest({ thread: thread(), catalog: chat, daemonPointing: [] }).tools;
  for (const name of ["update_todos", "control_desktop", "create_workflow", "edit_agent_profile", "read_file", "notify_user"]) assert.ok(tools.includes(name), name);
  assert.ok(!tools.includes("request_toolset"));
  // A workflow-owned chat: everything but the always-Admin tools.
  const owned = buildSessionToolsManifest({ thread: thread({ workflowOwned: true }), catalog: chat, daemonPointing: [] }).tools;
  assert.deepEqual(owned, withoutBoxes.filter((t) => t.tier !== "admin").map((t) => t.name));
  assert.ok(owned.includes("update_todos") && !owned.includes("edit_agent_profile"));
});
