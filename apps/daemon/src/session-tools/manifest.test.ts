/**
 * The per-thread manifest (unified MCP design 2026-10-15 §9.4, §12.1, spec §14.2.5): tools per
 * toolset and workflow-owned trait, the instruction block, and the deny list per thread (agent,
 * account home, project) — and `request_toolset`'s availability per provider (Task 6 probes).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { DaemonPointingServer } from "@orquester/api";
import { z } from "zod";

import { defineTool, READ_ONLY, type AnyOrquesterTool, type Tier, type ToolsetId } from "../mcp/catalog/contract.ts";
import { catalogFor } from "../mcp/catalog/index.ts";
import { composeOrquesterInstructions } from "./instructions.ts";
import {
  advertisedChatTools,
  buildSessionToolsManifest,
  denyFor,
  SESSION_TOOLS_LIVE_REFRESH,
  toolsetAvailability,
  type ManifestThread
} from "./manifest.ts";

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

test("the advertised tools are the resolved toolsets', in catalog order", () => {
  assert.deepEqual(advertisedChatTools(CATALOG, new Set(["core", "reads"]), false), ["list_sessions", "list_workflows"]);
  assert.deepEqual(advertisedChatTools(CATALOG, new Set(["core", "notes", "workflow-authoring"]), false), [
    "list_sessions",
    "update_todos",
    "create_workflow",
    "update_saved_prompts"
  ]);
});

test("a workflow-owned chat is advertised no always-Admin tool; per-call tiers stay (the gate refuses their Admin calls)", () => {
  assert.deepEqual(advertisedChatTools(CATALOG, new Set(["core", "notes", "workflow-authoring"]), true), ["list_sessions", "update_todos", "update_saved_prompts"]);
});

test("request_toolset is never advertised to a workflow-owned chat (nobody can approve its card there, §5.4)", () => {
  const chat = catalogFor("chat");
  assert.ok(advertisedChatTools(chat, new Set(["core"]), false).includes("request_toolset"));
  assert.ok(!advertisedChatTools(chat, new Set(["core"]), true).includes("request_toolset"));
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
    server({ name: "outside", scope: "project", projectPath: "/w/acme" })
  ];
  assert.deepEqual(denyFor(thread({ cwdPaths: ["/w/acme/api/packages/app"] }), servers), ["at_cwd", "on_the_way", "root"]);
  assert.deepEqual(denyFor(thread(), servers), ["root"], "at the project root: the root's alone");
});

test("deny: a Codex project server only in a home whose Codex loads it (it trusts the project)", () => {
  const codex = (loadedByHomes?: string[]) => server({ agent: "codex", home: "system", scope: "project", projectPath: "/w/acme/api", name: "proj", ...(loadedByHomes ? { loadedByHomes } : {}) });
  assert.deepEqual(denyFor(thread({ agentId: "codex", home: "acct-1" }), [codex(["acct-1"])]), ["proj"]);
  assert.deepEqual(denyFor(thread({ agentId: "codex", home: "system" }), [codex(["acct-1"])]), [], "another home's trust is not this one's");
  assert.deepEqual(denyFor(thread({ agentId: "codex", home: "acct-1" }), [codex([])]), [], "untrusted everywhere: never denied");
  assert.deepEqual(denyFor(thread({ agentId: "codex", home: "acct-1" }), [codex()]), ["proj"], "absent: an older detector — every home");
});

test("deny: a server every home of the agent loads (Grok's inherited ~/.claude.json, allHomes) is denied in an account home too", () => {
  const inherited = server({ agent: "grok", home: "system", name: "claude_inherited", allHomes: true });
  const ownConfig = server({ agent: "grok", home: "system", name: "grok_system_only" });
  assert.deepEqual(denyFor(thread({ agentId: "grok", home: "acct-g" }), [inherited, ownConfig]), ["claude_inherited"]);
  assert.deepEqual(denyFor(thread({ agentId: "grok", home: "system" }), [inherited, ownConfig]), ["claude_inherited", "grok_system_only"]);
  assert.deepEqual(denyFor(thread({ agentId: "claude", home: "acct-g" }), [inherited]), [], "only the agent it is reported under");
});

test("the manifest: tools, the composed block, the deny list and the toolsets", () => {
  const manifest = buildSessionToolsManifest({
    thread: thread({ workflowOwned: true }),
    toolsets: ["core", "reads"],
    agentToolsEnabled: true,
    catalog: CATALOG,
    daemonPointing: [server({})]
  });
  assert.deepEqual(manifest.tools, ["list_sessions", "list_workflows"]);
  assert.deepEqual(manifest.deny, ["orquester_remote"]);
  assert.deepEqual(manifest.toolsets, ["core", "reads"]);
  // Workflow-owned: the line, and no request_toolset hint (it is refused there, §5.4).
  assert.equal(manifest.instructions, composeOrquesterInstructions({ enabledToolsets: new Set(["core", "reads"]), workflowOwned: true, canRequestToolsets: false }));
  assert.doesNotMatch(manifest.instructions, /request_toolset with its id/);
});

test("the production catalog's default chat set is advertised to a fresh chat", () => {
  const manifest = buildSessionToolsManifest({ thread: thread(), toolsets: ["core", "reads"], agentToolsEnabled: true, catalog: catalogFor("chat"), daemonPointing: [] });
  assert.deepEqual(
    manifest.tools,
    catalogFor("chat").filter((t) => t.toolset === "core" || t.toolset === "reads").map((t) => t.name)
  );
  assert.ok(manifest.tools.length > 0);
});

test("request_toolset's availability: in-session only where the provider re-lists (Claude, probed)", () => {
  assert.equal(toolsetAvailability("claude"), "now");
  for (const agent of ["codex", "grok", "opencode", "unknown"]) assert.equal(toolsetAvailability(agent), "after-restart", agent);
  assert.deepEqual(Object.keys(SESSION_TOOLS_LIVE_REFRESH).sort(), ["claude", "codex", "grok", "opencode"]);
});
