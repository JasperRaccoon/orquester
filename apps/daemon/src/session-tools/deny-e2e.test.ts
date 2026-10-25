/**
 * Chat-manifest denials end to end (unified MCP design 2026-10-15 §12.1, Task 6 x Task 11): a user
 * MCP server carrying this daemon's bearer, in each provider's own user config, is found by Task 11's
 * real detector behind its real route and lands in the deny list of that provider's chat manifest
 * (Task 6's refresher reading the route in-process). Grok also loads the user's Claude servers in
 * every home, a managed account included.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import Fastify from "fastify";
import type { AgentAdapterId } from "@orquester/api/agent-chat";

import type { AgentHomes } from "../agent-profile/adapters/types.ts";
import { DaemonMcpDetector, listProjectDirs, registerDaemonMcpServersRoutes } from "../agent-profile/daemon-mcp.ts";
import { catalogFor } from "../mcp/catalog/index.ts";
import type { DaemonApi } from "../mcp/daemon-api.ts";
import { SessionToolsRefresher } from "./session-tools-refresh.ts";

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

test("Codex: a project-level server is denied in every home, trusted or not; trust is display only", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orq-deny-trust-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const homes: AgentHomes = {
    home, claudeDir: join(home, ".claude"), claudeJson: join(home, ".claude.json"), codexHome: join(home, ".codex"),
    grokHome: join(home, ".grok"), opencodeDir: join(home, ".config", "opencode"), agentsSkillsDir: join(home, ".agents", "skills")
  };
  const workspaces = join(root, "workspaces");
  const project = join(workspaces, "acme", "api");
  await mkdir(join(project, ".git"), { recursive: true });
  await write(join(project, ".codex", "config.toml"), ["[mcp_servers.proj_orq]", `url = "http://127.0.0.1:${PORT}/mcp"`].join("\n"));
  const trusting = join(root, "accounts", "codex", "acct-t", "home");
  const untrusting = join(root, "accounts", "codex", "acct-u", "home");
  const unreadable = join(root, "accounts", "codex", "acct-x", "home");
  const trusted = `[projects."${project}"]\ntrust_level = "trusted"\n`;
  await write(join(trusting, "config.toml"), trusted);
  await write(join(untrusting, "config.toml"), `[projects."${project}"]\ntrust_level = "untrusted"\n`);
  await write(join(unreadable, "config.toml"), `[projects."${project}"\ntrust_level = "trusted"\n`);
  await write(join(homes.codexHome, "config.toml"), "");

  const detector = new DaemonMcpDetector(
    { verifyBearer: () => false, httpPort: () => PORT, publicOrigins: () => [], env: () => undefined },
    {
      homes,
      accountHomes: async (agent) =>
        agent === "codex" ? [{ id: "acct-t", home: trusting }, { id: "acct-u", home: untrusting }, { id: "acct-x", home: unreadable }] : [],
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
    async request(method: string, path: string, opts?: { query?: Record<string, string> }) {
      const query = opts?.query ? `?${new URLSearchParams(opts.query).toString()}` : "";
      const res = await app.inject({ method: method as "GET", url: `${path}${query}` });
      return { status: res.statusCode, body: res.body ? res.json() : null };
    }
  } as unknown as DaemonApi;
  const refresher = new SessionToolsRefresher({
    thread: (id) => ({ agentId: "codex", home: id, projectPath: project }),
    openThreads: () => [],
    catalog: () => catalogFor("chat"),
    api: () => api,
    pushToHost: async () => null
  });
  const deny = async (home: string): Promise<string[]> => {
    const manifest = await refresher.manifest(home);
    assert.ok(manifest !== null && manifest !== "unavailable", `${home}: a manifest`);
    return [...manifest.deny];
  };

  // Denied in every home, whatever its trust: where Codex loads it, it is switched off; where it
  // does not (untrusted, no entry, an unreadable trust table), the denial is a disabled stub —
  // harmless, never "invalid transport" (probed on 0.159.0).
  for (const home of ["acct-t", "acct-u", "system", "acct-x"]) assert.deepEqual(await deny(home), ["proj_orq"], home);
  // The panel still lists the server, saying which homes load it.
  const listed = (await app.inject({ method: "GET", url: "/api/agent-profile/daemon-mcp-servers" })).json() as { servers: Array<{ name: string; loadedByHomes?: string[] }> };
  assert.deepEqual(listed.servers.find((server) => server.name === "proj_orq")?.loadedByHomes, ["acct-t"]);
});

test("a chat whose cwd resolves outside its project, or whose project's real path is outside the workspaces root, denies every server known — and what its real location configures", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orq-deny-escape-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const homes: AgentHomes = {
    home, claudeDir: join(home, ".claude"), claudeJson: join(home, ".claude.json"), codexHome: join(home, ".codex"),
    grokHome: join(home, ".grok"), opencodeDir: join(home, ".config", "opencode"), agentsSkillsDir: join(home, ".agents", "skills")
  };
  const workspaces = join(root, "workspaces");
  const project = join(workspaces, "acme", "api");
  const target = join(workspaces, "acme", "web", "deep");
  const outside = join(root, "outside", "ext");
  await mkdir(join(outside, "sub"), { recursive: true });
  await mkdir(target, { recursive: true });
  await mkdir(project, { recursive: true });
  const url = `http://127.0.0.1:${PORT}/mcp`;
  await write(homes.claudeJson, JSON.stringify({ mcpServers: { user_orq: { type: "http", url } } }));
  await write(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { root_orq: { type: "http", url } } }));
  // The escape target configures one of its own (inside the workspaces root, below another project's root).
  await write(join(target, ".mcp.json"), JSON.stringify({ mcpServers: { target_orq: { type: "http", url } } }));
  // The uncontained project configures one of its own.
  await write(join(outside, ".mcp.json"), JSON.stringify({ mcpServers: { ext_orq: { type: "http", url } } }));
  // A cwd inside the project by name, elsewhere by its real path.
  await symlink(target, join(project, "link"));
  // A project whose real path is outside the workspaces root.
  await symlink(outside, join(workspaces, "acme", "ext"));

  const detector = new DaemonMcpDetector(
    { verifyBearer: () => false, httpPort: () => PORT, publicOrigins: () => [], env: () => undefined },
    { homes, accountHomes: async () => [], projects: () => listProjectDirs(workspaces), workspacesRoot: () => workspaces }
  );
  const app = Fastify();
  registerDaemonMcpServersRoutes(app, { detector, mode: "local" });
  await app.ready();
  t.after(() => app.close());
  const api = {
    fsRoot: root,
    workspacesDir: workspaces,
    async request(method: string, path: string, opts?: { query?: Record<string, string> }) {
      const query = opts?.query ? `?${new URLSearchParams(opts.query).toString()}` : "";
      const res = await app.inject({ method: method as "GET", url: `${path}${query}` });
      return { status: res.statusCode, body: res.body ? res.json() : null };
    }
  } as unknown as DaemonApi;
  const threads: Record<string, { projectPath: string; canonicalProjectPath: string; cwd: string; canonicalCwd: string }> = {
    "symlinked-cwd": { projectPath: project, canonicalProjectPath: project, cwd: join(project, "link"), canonicalCwd: target },
    "uncontained-project": {
      projectPath: join(workspaces, "acme", "ext"),
      canonicalProjectPath: outside,
      cwd: join(workspaces, "acme", "ext", "sub"),
      canonicalCwd: join(outside, "sub")
    },
    "uncontained-root": { projectPath: join(workspaces, "acme", "ext"), canonicalProjectPath: outside, cwd: join(workspaces, "acme", "ext"), canonicalCwd: outside }
  };
  const refresher = new SessionToolsRefresher({
    thread: (id) => (threads[id] ? { agentId: "claude", home: "system", ...threads[id]! } : null),
    openThreads: () => Object.keys(threads),
    catalog: () => catalogFor("chat"),
    api: () => api,
    pushToHost: async () => null
  });
  const deny = async (threadId: string): Promise<string[]> => {
    const manifest = await refresher.manifest(threadId);
    assert.ok(manifest !== null && manifest !== "unavailable", `${threadId}: a manifest, never "unavailable"`);
    return [...manifest.deny];
  };
  const everything = ["ext_orq", "root_orq", "target_orq", "user_orq"];
  // The escape target's own config, and every name known anywhere (over-deny by name: harmless).
  assert.deepEqual(await deny("symlinked-cwd"), everything);
  // The detection refuses the project (400 PATH_NOT_CONTAINED): the same over-deny, its own config
  // included (read through the project's link) — again and again, never "unavailable".
  // (The escape target's config lies below another project's root: only a chat there reads it.)
  const known = ["ext_orq", "root_orq", "user_orq"];
  assert.deepEqual(await deny("uncontained-project"), known);
  assert.deepEqual(await deny("uncontained-project"), known);
  assert.deepEqual(await deny("uncontained-root"), known);
  // Only the containment refusal is "uncontained": any other 400 is a failed read.
  const other = new SessionToolsRefresher({
    thread: () => ({ agentId: "claude", home: "system", ...threads["uncontained-project"]! }),
    openThreads: () => [],
    catalog: () => catalogFor("chat"),
    api: () => ({ request: async () => ({ status: 400, body: { error: { code: "INVALID_REQUEST", message: "x" } } }) }) as unknown as DaemonApi,
    pushToHost: async () => null
  });
  assert.equal(await other.manifest("x"), "unavailable");
});
