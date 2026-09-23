import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDaemonApi } from "../testing.ts";
import { chatSummary, stamp } from "../fixtures.ts";
import type { ToolContext } from "../tool.ts";
import { catalogTools } from "./catalog.ts";

const tool = (name: string) => catalogTools.find((t) => t.name === name)!;
const ctx = (api: FakeDaemonApi): ToolContext => ({ api, todos: {} as never, files: {} as never, signal: new AbortController().signal, now: () => Date.parse("2026-09-22T12:00:00.000Z") });

test("list_projects flattens workspaces, hides archived by default, marks recency and open sessions, recent first", async () => {
  const api = new FakeDaemonApi()
    .on("GET", "/api/workspaces", { status: 200, body: [{ name: "acme", path: "/w/acme", projectCount: 2 }, { name: "old", path: "/w/old", projectCount: 1, isArchived: true }] })
    .on("GET", "/api/workspaces/acme/projects", { status: 200, body: [{ name: "api", workspace: "acme", path: "/w/acme/api" }, { name: "web", workspace: "acme", path: "/w/acme/web", isArchived: true }] })
    .on("GET", "/api/workspaces/old/projects", { status: 200, body: [{ name: "x", workspace: "old", path: "/w/old/x" }] })
    .on("GET", "/api/projects/recent", { status: 200, body: [{ name: "api", workspace: "acme", path: "/w/acme/api", lastInteractedAt: stamp(5), interactionCount: 3 }] })
    .on("GET", "/api/sessions", { status: 200, body: [chatSummary(), chatSummary({ id: "c2" })] });
  const r = await tool("list_projects").run({ includeArchived: false }, ctx(api));
  assert.deepEqual(r, { projects: [{ workspace: "acme", name: "api", path: "/w/acme/api", isArchived: false, lastInteractedAt: stamp(5), openSessions: 2 }] });
  const all = await tool("list_projects").run({ includeArchived: true }, ctx(api));
  assert.deepEqual((all.projects as { path: string }[]).map((p) => p.path), ["/w/acme/api", "/w/acme/web", "/w/old/x"]);
  const one = await tool("list_projects").run({ workspace: "old", includeArchived: true }, ctx(api));
  assert.equal((one.projects as unknown[]).length, 1);
});

test("list_projects reports a project of an archived workspace as archived (the daemon's project flag is per-project only)", async () => {
  const api = new FakeDaemonApi()
    .on("GET", "/api/workspaces", { status: 200, body: [{ name: "old", path: "/w/old", projectCount: 1, isArchived: true }] })
    .on("GET", "/api/workspaces/old/projects", { status: 200, body: [{ name: "x", workspace: "old", path: "/w/old/x", isArchived: false }] })
    .on("GET", "/api/projects/recent", { status: 200, body: [] })
    .on("GET", "/api/sessions", { status: 200, body: [] });
  const r = await tool("list_projects").run({ includeArchived: true }, ctx(api));
  assert.deepEqual(r, { projects: [{ workspace: "old", name: "x", path: "/w/old/x", isArchived: true, openSessions: 0 }] });
});

test("list_projects orders recent projects newest first, then the rest alphabetically", async () => {
  const api = new FakeDaemonApi()
    .on("GET", "/api/workspaces", { status: 200, body: [{ name: "zeta", path: "/w/zeta", projectCount: 1 }, { name: "acme", path: "/w/acme", projectCount: 3 }] })
    .on("GET", "/api/workspaces/zeta/projects", { status: 200, body: [{ name: "a", workspace: "zeta", path: "/w/zeta/a" }] })
    .on("GET", "/api/workspaces/acme/projects", { status: 200, body: [{ name: "d", workspace: "acme", path: "/w/acme/d" }, { name: "c", workspace: "acme", path: "/w/acme/c" }, { name: "b", workspace: "acme", path: "/w/acme/b" }] })
    .on("GET", "/api/projects/recent", { status: 200, body: [{ name: "c", workspace: "acme", path: "/w/acme/c", lastInteractedAt: stamp(3), interactionCount: 1 }, { name: "a", workspace: "zeta", path: "/w/zeta/a", lastInteractedAt: stamp(7), interactionCount: 1 }] })
    .on("GET", "/api/sessions", { status: 200, body: [] });
  const r = await tool("list_projects").run({ includeArchived: false }, ctx(api));
  assert.deepEqual((r.projects as { path: string }[]).map((p) => p.path), ["/w/zeta/a", "/w/acme/c", "/w/acme/b", "/w/acme/d"]);
});

test("list_agents returns the catalogue, optionally one agent", async () => {
  const api = new FakeDaemonApi()
    .on("GET", "/api/registry", { status: 200, body: { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [{ id: "claude", kind: "agent", name: "Claude Code", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } }, { id: "grok", kind: "agent", name: "Grok Build", bin: ["grok"], enabled: true, installState: "idle", chat: { adapter: "grok" } }] } })
    .on("GET", "/api/agent/providers", { status: 200, body: { hostInstanceId: "h", providers: [] } })
    .on("GET", "/api/agent-accounts", { status: 200, body: { accounts: [], defaults: { claude: null, codex: null, grok: null } } });
  const r = await tool("list_agents").run({ includeLegacyModels: false }, ctx(api));
  assert.deepEqual((r.agents as { id: string }[]).map((a) => a.id), ["claude", "grok"]);
  const one = await tool("list_agents").run({ agent: "grok", includeLegacyModels: false }, ctx(api));
  assert.deepEqual((one.agents as { id: string }[]).map((a) => a.id), ["grok"]);
  await assert.rejects(tool("list_agents").run({ agent: "nope", includeLegacyModels: false }, ctx(api)), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
});

test("list_conversations resolves the project, maps homes to launch agents and flags resumability", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mcp-cat-")); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "acme", "api"), { recursive: true });
  const api = new FakeDaemonApi(); api.fsRoot = root; api.workspacesDir = root;
  api.on("GET", "/api/registry", { status: 200, body: { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [{ id: "claude", kind: "agent", name: "Claude Code", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } }, { id: "claudex", kind: "agent", name: "Claude Code × GPT", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } }] } })
    .on("GET", "/api/agents/conversations", ({ query }) => ({ status: 200, body: { conversations: [
      { id: "s1", agentRefId: "claude", title: "Fix build", updatedAt: stamp(9), home: "account", accountId: "acc-1" },
      { id: "s2", agentRefId: "claude", title: "Proxy chat", updatedAt: stamp(8), home: "cliproxy", proxyRefId: "claudex" },
      { id: "s3", agentRefId: "deepseek", title: "Old", updatedAt: stamp(7) },
      { id: "s4", agentRefId: "claude", title: "Other", preview: "p", updatedAt: stamp(6), home: "system" }
    ].filter(() => query?.path === join(root, "acme", "api")) } }));
  const r = await tool("list_conversations").run({ project: "acme/api", limit: 3 }, ctx(api));
  assert.deepEqual(r, { conversations: [
    { id: "s1", agent: "claude", title: "Fix build", updatedAt: stamp(9), home: "account", accountId: "acc-1", resumable: true },
    { id: "s2", agent: "claudex", title: "Proxy chat", updatedAt: stamp(8), home: "cliproxy", resumable: true },
    { id: "s3", agent: "deepseek", title: "Old", updatedAt: stamp(7), home: "system", resumable: false }
  ] });
  const only = await tool("list_conversations").run({ project: join(root, "acme", "api"), agent: "claudex", limit: 20 }, ctx(api));
  assert.deepEqual((only.conversations as { id: string }[]).map((c) => c.id), ["s2"]);
});
