/**
 * Chat-manifest denials end to end (unified MCP design 2026-10-15 §12.1, Task 6 x Task 11): a user
 * MCP server carrying this daemon's bearer, in each provider's own user config, is found by Task 11's
 * real detector behind its real route and lands in the deny list of that provider's chat manifest
 * (Task 6's refresher reading the route in-process). Grok also loads the user's Claude servers in
 * every home, a managed account included.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import Fastify from "fastify";
import type { AgentAdapterId } from "@orquester/api/agent-chat";

import type { AgentHomes } from "../agent-profile/adapters/types.ts";
import { DaemonMcpDetector, listProjectDirs, registerDaemonMcpServersRoutes } from "../agent-profile/daemon-mcp.ts";
import { catalogFor } from "../mcp/catalog/index.ts";
import type { DaemonApi } from "../mcp/daemon-api.ts";
import { SessionToolsRefresher } from "./toolset-refresh.ts";

const BEARER = "dXNlcjokMmEkMTIkZTJlLWhhc2g="; // base64("user:$2a$12$e2e-hash"): the daemon's own bearer in this test
const PORT = 47899;

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

test("a user MCP server carrying this daemon's bearer is denied in the chat manifest of every provider (Grok: also the Claude servers it inherits, in an account home)", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orq-deny-e2e-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const homes: AgentHomes = {
    home, claudeDir: join(home, ".claude"), claudeJson: join(home, ".claude.json"), codexHome: join(home, ".codex"),
    grokHome: join(home, ".grok"), opencodeDir: join(home, ".config", "opencode"), agentsSkillsDir: join(home, ".agents", "skills")
  };
  const workspaces = join(root, "workspaces");
  const project = join(workspaces, "acme", "api");
  await mkdir(project, { recursive: true });
  const grokAccount = join(root, "accounts", "grok", "acct-g", "home");
  await write(join(grokAccount, "config.toml"), "");

  // Each provider's user config holds one server with the bearer, beside a harmless one.
  await write(homes.claudeJson, JSON.stringify({
    mcpServers: {
      claude_orq: { type: "http", url: "https://proxy.example/anything", headers: { Authorization: `Bearer ${BEARER}` } },
      claude_fine: { command: "fine" }
    }
  }));
  await write(join(homes.codexHome, "config.toml"), [
    "[mcp_servers.codex_orq]", 'url = "https://proxy.example/x"', "[mcp_servers.codex_orq.http_headers]", `Authorization = "Bearer ${BEARER}"`, "",
    "[mcp_servers.codex_fine]", 'command = "fine"'
  ].join("\n"));
  await write(join(homes.grokHome, "config.toml"), [
    "[mcp_servers.grok_orq]", 'command = "npx"', `args = ["-y", "mcp-remote", "https://proxy.example/mcp", "--header", "Authorization: Bearer ${BEARER}"]`, "",
    "[mcp_servers.grok_fine]", 'command = "fine"'
  ].join("\n"));
  await write(join(homes.opencodeDir, "opencode.json"), JSON.stringify({
    mcp: {
      oc_orq: { type: "remote", url: "https://proxy.example/mcp", headers: { Authorization: `Bearer ${BEARER}` } },
      oc_fine: { type: "local", command: ["fine"] }
    }
  }));

  // Task 11's real detector and route, read through the daemon's in-process API shape.
  const detector = new DaemonMcpDetector(
    { verifyBearer: (token) => token === BEARER, httpPort: () => PORT, publicOrigins: () => [], env: () => undefined },
    {
      homes,
      accountHomes: async (agent) => (agent === "grok" ? [{ id: "acct-g", home: grokAccount }] : []),
      projects: () => listProjectDirs(workspaces),
      workspacesRoot: () => workspaces
    }
  );
  const app = Fastify();
  registerDaemonMcpServersRoutes(app, { detector, mode: "local" });
  await app.ready();
  t.after(() => app.close());
  const api = {
    fsRoot: root,
    workspacesDir: workspaces,
    async request(method: string, path: string) {
      const res = await app.inject({ method: method as "GET", url: path });
      return { status: res.statusCode, body: res.body ? res.json() : null };
    }
  } as unknown as DaemonApi;

  const threads: Record<string, { agentId: AgentAdapterId; home: string }> = {
    "claude-1": { agentId: "claude", home: "system" },
    "codex-1": { agentId: "codex", home: "system" },
    "grok-system": { agentId: "grok", home: "system" },
    "grok-account": { agentId: "grok", home: "acct-g" },
    "opencode-1": { agentId: "opencode", home: "system" }
  };
  const refresher = new SessionToolsRefresher({
    thread: (id) => (threads[id] ? { ...threads[id]!, projectPath: project } : null),
    openThreads: () => Object.keys(threads),
    resolvedToolsets: () => ["core"],
    agentToolsEnabled: () => true,
    catalog: () => catalogFor("chat"),
    api: () => api,
    pushToHost: async () => null
  });
  const deny = async (threadId: string): Promise<string[]> => {
    const manifest = await refresher.manifest(threadId);
    assert.ok(manifest !== null && manifest !== "unavailable", `${threadId}: a manifest`);
    assert.ok(!JSON.stringify(manifest).includes(BEARER), "the manifest never carries the credential");
    return [...manifest.deny];
  };

  assert.deepEqual(await deny("claude-1"), ["claude_orq"]);
  assert.deepEqual(await deny("codex-1"), ["codex_orq"]);
  assert.deepEqual(await deny("opencode-1"), ["oc_orq"]);
  // Grok in the system home: its own config's server and the Claude server it inherits.
  assert.deepEqual(await deny("grok-system"), ["claude_orq", "grok_orq"]);
  // Grok in a managed account (GROK_HOME only): the inherited Claude server still loads; the system
  // Grok config's does not.
  assert.deepEqual(await deny("grok-account"), ["claude_orq"]);
});
