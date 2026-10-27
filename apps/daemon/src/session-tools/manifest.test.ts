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
import { buildSessionToolsManifest, denyFor, type ManifestKnowledge, type ManifestThread } from "./manifest.ts";

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
  const normal = buildSessionToolsManifest({ thread: thread(), catalog: CATALOG, daemonPointing: [] });
  assert.deepEqual(normal.tools, ["list_sessions", "list_workflows", "update_todos", "create_workflow", "update_saved_prompts"]);
  const manifest = buildSessionToolsManifest({ thread: thread({ workflowOwned: true }), catalog: CATALOG, daemonPointing: [server({})] });
  assert.deepEqual(manifest.tools, ["list_sessions", "list_workflows", "update_todos", "update_saved_prompts"]);
  assert.deepEqual(manifest.deny, ["orquester_remote"]);
  assert.equal(manifest.toolsets, undefined);
  assert.match(manifest.instructions, /automated workflow/);
  assert.match(manifest.instructions, /approval.*not available/);
});

// ---------------------------------------------------------------------------
// Knowledge Graph plugin: the `knowledge` toolset's gating and the knowledge line
// ---------------------------------------------------------------------------

const USER_KNOWLEDGE = ["knowledge_search", "knowledge_get", "knowledge_save", "knowledge_update", "knowledge_delete", "knowledge_collections"];
const WORKER_KNOWLEDGE = ["knowledge_worker_next_task", "knowledge_worker_submit"];
const KNOWLEDGE_LINE = /\nKnowledge: .*knowledge_search/;

const knowledge = (over: Partial<ManifestKnowledge> = {}): ManifestKnowledge => ({ enabled: true, worker: false, searchable: true, visibleCollectionNames: ["SEO", "Ads"], ...over });

test("knowledge gating matrix: plugin off/on × Global / profile with collections / profile without × worker / not", () => {
  const chat = catalogFor("chat");
  const build = (k?: ManifestKnowledge, workflowOwned = false) => buildSessionToolsManifest({ thread: thread({ workflowOwned }), catalog: chat, daemonPointing: [], ...(k ? { knowledge: k } : {}) });
  const knowledgeOf = (tools: string[]) => tools.filter((name) => name.startsWith("knowledge_"));

  // Plugin off (unwired, or off): no knowledge tool, no line — whatever the chat sees.
  for (const k of [undefined, knowledge({ enabled: false }), knowledge({ enabled: false, searchable: false, visibleCollectionNames: [] })]) {
    const manifest = build(k);
    assert.deepEqual(knowledgeOf(manifest.tools), []);
    assert.doesNotMatch(manifest.instructions, /Knowledge:|knowledge_search/);
  }
  // On, Global (every collection) and a profile ticking collections: the four user tools, the line naming them.
  for (const names of [["SEO", "Ads", "SaaS"], ["SEO"]]) {
    const manifest = build(knowledge({ visibleCollectionNames: names }));
    assert.deepEqual(knowledgeOf(manifest.tools), USER_KNOWLEDGE);
    assert.match(manifest.instructions, KNOWLEDGE_LINE);
    for (const name of names) assert.ok(manifest.instructions.includes(name), name);
  }
  // On, Global with no collection yet (Unfiled entries only): search stays, no line to write.
  const unfiledOnly = build(knowledge({ visibleCollectionNames: [] }));
  assert.deepEqual(knowledgeOf(unfiledOnly.tools), USER_KNOWLEDGE);
  assert.doesNotMatch(unfiledOnly.instructions, KNOWLEDGE_LINE);
  // On, a profile with none ticked (or only deleted ones): save and collections, no search/get, no line.
  const blind = build(knowledge({ searchable: false, visibleCollectionNames: [] }));
  assert.deepEqual(knowledgeOf(blind.tools), ["knowledge_save", "knowledge_collections"]);
  assert.doesNotMatch(blind.instructions, /Knowledge:|knowledge_search/);
  // A non-worker never gets the worker tools.
  for (const k of [knowledge(), knowledge({ searchable: false }), knowledge({ enabled: false })]) {
    for (const name of WORKER_KNOWLEDGE) assert.ok(!build(k).tools.includes(name), name);
  }
  // A worker gets ONLY the two worker tools and its own short block — on or off, whatever it "sees".
  for (const k of [knowledge({ worker: true }), knowledge({ worker: true, searchable: false, visibleCollectionNames: [] }), knowledge({ worker: true, enabled: false })]) {
    for (const workflowOwned of [false, true]) {
      const manifest = build(k, workflowOwned);
      assert.deepEqual(manifest.tools, WORKER_KNOWLEDGE);
      const namedTools = [...manifest.instructions.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map((match) => match[0]);
      assert.deepEqual(namedTools, WORKER_KNOWLEDGE);
      assert.ok(Buffer.byteLength(manifest.instructions, "utf8") <= 256);
      assert.deepEqual(manifest.deny, []);
    }
  }
  // Boxes and knowledge gate independently.
  const both = buildSessionToolsManifest({ thread: thread(), catalog: chat, daemonPointing: [], boxesAvailable: true, knowledge: knowledge() });
  const ownedRenting = buildSessionToolsManifest({ thread: thread({ workflowOwned: true }), catalog: chat, daemonPointing: [], boxesAvailable: true });
  for (const name of ["create_box", "box_exec", "destroy_box"]) {
    assert.ok(!build().tools.includes(name), `${name}: unavailable without a box backend`);
    assert.ok(both.tools.includes(name), name);
    assert.ok(ownedRenting.tools.includes(name), `${name}: a workflow-owned chat may rent a box`);
  }
});

test("knowledge: a workflow-owned chat keeps the knowledge tools (none is Admin) and gets both lines, under the raised cap", () => {
  const chat = catalogFor("chat");
  const manifest = buildSessionToolsManifest({ thread: thread({ workflowOwned: true }), catalog: chat, daemonPointing: [], knowledge: knowledge({ visibleCollectionNames: Array.from({ length: 100 }, (_, i) => `Collection ${i}`) }) });
  assert.deepEqual(manifest.tools.filter((name) => name.startsWith("knowledge_")), USER_KNOWLEDGE);
  assert.match(manifest.instructions, /automated workflow/);
  assert.match(manifest.instructions, /approval.*not available/);
  assert.match(manifest.instructions, KNOWLEDGE_LINE);
  assert.ok(Buffer.byteLength(manifest.instructions, "utf8") <= 2_304);
});

test("devices: the device tools and their instruction line only while devices are available", () => {
  const chat = catalogFor("chat");
  const DEVICE_TOOLS = ["list_devices", "open_device", "device_action", "device_install", "close_device"];
  const off = buildSessionToolsManifest({ thread: thread(), catalog: chat, daemonPointing: [] });
  const on = buildSessionToolsManifest({ thread: thread(), catalog: chat, daemonPointing: [], devicesAvailable: true });
  const owned = buildSessionToolsManifest({ thread: thread({ workflowOwned: true }), catalog: chat, daemonPointing: [], devicesAvailable: true });
  for (const name of DEVICE_TOOLS) {
    assert.ok(!off.tools.includes(name), `${name}: not advertised while devices are unavailable`);
    assert.ok(on.tools.includes(name), name);
    assert.ok(owned.tools.includes(name), `${name}: none is Admin, so a workflow-owned chat keeps it`);
  }
  assert.doesNotMatch(off.instructions, /list_devices/);
  assert.match(on.instructions, /Mobile devices: list_devices, open_device;/);
  // Gated independently of the box tools.
  assert.ok(!on.tools.includes("create_box"));
});
