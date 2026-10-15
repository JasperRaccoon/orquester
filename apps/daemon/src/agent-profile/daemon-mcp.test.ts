/**
 * Daemon-pointing MCP detection (unified MCP design 2026-10-15 §12.1, §14.2.8): bearer and URL
 * matches, the `orquester` name, every CLI's config shape, user configs of the system home and of
 * every managed account home, project-level configs, the per-project filter, and the routes —
 * which never echo a credential.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import type { DaemonPointingServer } from "@orquester/api";
import type { AgentHomes } from "./adapters/types.ts";
import { DaemonMcpDetector, listProjectDirs, pointingReason, registerDaemonMcpServersRoutes, urlReachesDaemon, type DaemonMcpIdentity } from "./daemon-mcp.ts";

const BEARER = "dXNlcjokMmEkMTIkc2VjcmV0LWhhc2g="; // base64("user:$2a$12$secret-hash")
const PORT = 47831;

function identity(over: Partial<DaemonMcpIdentity> = {}): DaemonMcpIdentity & { verified: string[] } {
  const verified: string[] = [];
  return {
    verified,
    verifyBearer: (token) => {
      verified.push(token);
      return token === BEARER;
    },
    httpPort: () => PORT,
    publicOrigins: () => ["https://orq.example.com"],
    env: (name) => ({ ORQ_TOKEN: BEARER, OTHER: "nothing" } as Record<string, string>)[name],
    ...over
  };
}

async function write(path: string, text: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orq-daemon-mcp-")));
  const home = join(root, "home");
  const homes: AgentHomes = {
    home, claudeDir: join(home, ".claude"), claudeJson: join(home, ".claude.json"), codexHome: join(home, ".codex"),
    grokHome: join(home, ".grok"), opencodeDir: join(home, ".config", "opencode"), agentsSkillsDir: join(home, ".agents", "skills")
  };
  const workspaces = join(root, "workspaces");
  const project = join(workspaces, "acme", "api");
  const other = join(workspaces, "acme", "web");
  await mkdir(project, { recursive: true });
  await mkdir(other, { recursive: true });
  const accounts = join(root, "accounts");
  return { root, home, homes, workspaces, project, other, accounts };
}

const byKey = (servers: DaemonPointingServer[]) => servers.map((s) => `${s.agent}|${s.home}|${s.scope}|${s.projectPath ?? ""}|${s.name}|${s.reason}`).sort();

test("urlReachesDaemon: loopback on the daemon's port with path /mcp, or a configured origin", () => {
  for (const url of ["http://[::ffff:127.0.0.1]:47831/mcp", "http://[::ffff:7f00:1]:47831/mcp", "http://127.0.0.1:47831/mcp", "http://localhost:47831/mcp/", "http://[::1]:47831/mcp", "http://0.0.0.0:47831/mcp", "http://127.1.2.3:47831/mcp", "https://orq.example.com/mcp", "https://ORQ.example.com:443/mcp"]) {
    assert.equal(urlReachesDaemon(url, PORT, ["https://orq.example.com"]), true, url);
  }
  for (const url of ["http://127.0.0.1:47832/mcp", "http://127.0.0.1:47831/api", "http://10.0.0.1:47831/mcp", "http://[::ffff:10.0.0.1]:47831/mcp", "https://evil.example.com/mcp", "http://orq.example.com/mcp", "not a url"]) {
    assert.equal(urlReachesDaemon(url, PORT, ["https://orq.example.com"]), false, url);
  }
});

test("pointingReason: a bearer in a header, an argument or an env reference; the URL; the name; bearer wins", () => {
  const id = identity();
  assert.equal(pointingReason({ name: "x", values: [`Bearer ${BEARER}`], envRefs: [] }, id), "bearer");
  assert.equal(pointingReason({ name: "x", values: ["--header", `Authorization: Bearer ${BEARER}`], envRefs: [] }, id), "bearer");
  assert.equal(pointingReason({ name: "x", values: ["Bearer ${ORQ_TOKEN}"], envRefs: [] }, id), "bearer");
  assert.equal(pointingReason({ name: "x", values: [], envRefs: ["ORQ_TOKEN"] }, id), "bearer");
  assert.equal(pointingReason({ name: "x", url: "https://anything.example/mcp", values: [BEARER], envRefs: [] }, id), "bearer", "a credential is caught whatever the URL");
  assert.equal(pointingReason({ name: "x", url: "http://127.0.0.1:47831/mcp", values: ["Bearer other"], envRefs: [] }, id), "url");
  assert.equal(pointingReason({ name: "x", values: ["-y", "mcp-remote", "http://localhost:47831/mcp"], envRefs: [] }, id), "url");
  assert.equal(pointingReason({ name: "orquester", values: [], envRefs: [] }, id), "name");
  assert.equal(pointingReason({ name: "orquester_remote", url: "https://elsewhere.example/mcp", values: ["Bearer nope"], envRefs: ["OTHER"] }, id), null);
  assert.equal(pointingReason({ name: "x", values: [BEARER], envRefs: [] }, identity({ verifyBearer: () => false })), null);
});

test("detect: every CLI's user config shape in the system home", async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  await write(fx.homes.claudeJson, JSON.stringify({
    mcpServers: {
      orquester_remote: { type: "http", url: "https://orq.example.com/mcp", headers: { Authorization: `Bearer ${BEARER}` } },
      bridge: { command: "npx", args: ["-y", "mcp-remote", "http://127.0.0.1:47831/mcp"] },
      jira: { command: "node", args: ["jira.js"], env: { TOKEN: "jira-token" } }
    },
    projects: { [fx.project]: { mcpServers: { orquester: { command: "x" } } }, "/elsewhere": { mcpServers: { local: { url: "http://localhost:47831/mcp" } } } }
  }));
  await write(join(fx.homes.codexHome, "config.toml"), [
    "[mcp_servers.orq]", 'url = "https://unrelated.example/mcp"', 'bearer_token_env_var = "ORQ_TOKEN"', "",
    "[mcp_servers.orq2]", 'url = "https://x.example/mcp"', "[mcp_servers.orq2.http_headers]", `Authorization = "Bearer ${BEARER}"`, "",
    "[mcp_servers.fine]", 'command = "fine"'
  ].join("\n"));
  await write(join(fx.homes.grokHome, "config.toml"), ["[mcp_servers.orquester]", 'command = "something"', "", "[mcp_servers.g]", 'url = "http://localhost:47831/mcp"'].join("\n"));
  await write(join(fx.homes.opencodeDir, "opencode.jsonc"), `{
    // comments are fine
    "mcp": {
      "remote": { "type": "remote", "url": "https://elsewhere.example/x", "headers": { "Authorization": "Bearer ${BEARER}" } },
      "local": { "type": "local", "command": ["npx", "mcp-remote", "http://127.0.0.1:47831/mcp"], "environment": { "A": "b" } },
      "ok": { "type": "local", "command": ["ok"] },
    },
  }`);
  const id = identity();
  const logs: string[] = [];
  const detector = new DaemonMcpDetector(id, { homes: fx.homes, accountHomes: async () => [], projects: () => listProjectDirs(fx.workspaces), workspacesRoot: () => fx.workspaces, logger: { warn: (m) => logs.push(m) } });
  const servers = await detector.detect();
  assert.deepEqual(byKey(servers), [
    "claude|system|project|/elsewhere|local|url",
    `claude|system|project|${fx.project}|orquester|name`,
    "claude|system|user||bridge|url",
    "claude|system|user||orquester_remote|bearer",
    "codex|system|user||orq2|bearer",
    "codex|system|user||orq|bearer",
    "grok|system|user||bridge|url",
    "grok|system|user||g|url",
    "grok|system|user||orquester|name",
    "grok|system|user||orquester_remote|bearer",
    "opencode|system|user||local|url",
    "opencode|system|user||remote|bearer"
  ].sort());
  assert.ok(!JSON.stringify(servers).includes(BEARER), "the result never carries the credential");
  assert.ok(!logs.join("\n").includes(BEARER));
  // Grok's servers inherited from ~/.claude.json load in every Grok home (a managed account sets only
  // GROK_HOME): flagged allHomes — also when the same name sits in the system Grok config.
  const allHomes = servers.filter((s) => s.allHomes === true).map((s) => `${s.agent}|${s.name}`).sort();
  assert.deepEqual(allHomes, ["grok|bridge", "grok|orquester_remote"]);
  assert.equal(servers.find((s) => s.agent === "grok" && s.name === "g")?.allHomes, undefined, "a Grok config.toml server stays in its home");
});

test("detect: every managed account home, each file read once, and project-level configs (all projects or one)", async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  const claudeAccount = join(fx.accounts, "claude", "acc1", "home");
  const codexAccount = join(fx.accounts, "codex", "acc2", "home");
  // A Claude account keeps its own .claude.json; a Codex account's config.toml is a symlink to the system one.
  await write(join(claudeAccount, ".claude.json"), JSON.stringify({ mcpServers: { mine: { type: "http", url: "http://localhost:47831/mcp" } } }));
  await write(join(fx.homes.codexHome, "config.toml"), `[mcp_servers.shared]\nurl = "http://127.0.0.1:47831/mcp"\n`);
  await mkdir(codexAccount, { recursive: true });
  await symlink(join(fx.homes.codexHome, "config.toml"), join(codexAccount, "config.toml"));
  await write(join(fx.project, ".mcp.json"), JSON.stringify({ mcpServers: { proj: { type: "http", url: "http://localhost:47831/mcp" } } }));
  await write(join(fx.project, ".codex", "config.toml"), `[mcp_servers.pc]\nurl = "https://orq.example.com/mcp"\n`);
  await write(join(fx.project, ".grok", "config.toml"), `[mcp_servers.pg]\nheaders = { Authorization = "Bearer ${BEARER}" }\nurl = "https://x.example/mcp"\n`);
  await write(join(fx.other, "opencode.json"), JSON.stringify({ mcp: { po: { type: "remote", url: "http://localhost:47831/mcp" } } }));
  await write(join(fx.other, ".mcp.json"), "{ not json");
  const detector = new DaemonMcpDetector(identity(), {
    homes: fx.homes,
    accountHomes: async (agent) => (agent === "claude" ? [{ id: "acc1", home: claudeAccount }] : agent === "codex" ? [{ id: "acc2", home: codexAccount }] : []),
    projects: () => listProjectDirs(fx.workspaces),
    workspacesRoot: () => fx.workspaces
  });
  assert.deepEqual(byKey(await detector.detect()), [
    "claude|acc1|user||mine|url",
    `claude|system|project|${fx.project}|proj|url`,
    "codex|system|user||shared|url",
    `codex|system|project|${fx.project}|pc|url`,
    `grok|system|project|${fx.project}|pg|bearer`,
    `opencode|system|project|${fx.other}|po|url`
  ].sort());
  // A chat's manifest asks for its own project only: user configs plus that project's files.
  assert.deepEqual(byKey(await detector.detect({ projectPath: fx.other })), [
    "claude|acc1|user||mine|url",
    "codex|system|user||shared|url",
    `opencode|system|project|${fx.other}|po|url`
  ].sort());
});

test("routes: GET lists flagged servers on both transports; the socket-only check merges the item's current values and never echoes them", async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  await write(fx.homes.claudeJson, JSON.stringify({ mcpServers: { o: { type: "http", url: "https://y.example/mcp", headers: { Authorization: `Bearer ${BEARER}` } } } }));
  const detector = new DaemonMcpDetector(identity(), { homes: fx.homes, accountHomes: async () => [], projects: async () => [], workspacesRoot: () => fx.workspaces });
  const local = Fastify({ logger: false });
  const remote = Fastify({ logger: false });
  t.after(async () => { await local.close(); await remote.close(); });
  registerDaemonMcpServersRoutes(local, { detector, mode: "local", current: async (_agent, id) => (id === "mcp:o" ? { name: "o", values: [BEARER], envRefs: [] } : null) });
  registerDaemonMcpServersRoutes(remote, { detector, mode: "remote" });
  for (const app of [local, remote]) {
    const res = await app.inject({ method: "GET", url: "/api/agent-profile/daemon-mcp-servers" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { servers: [{ agent: "claude", home: "system", scope: "user", name: "o", reason: "bearer" }, { agent: "grok", home: "system", scope: "user", name: "o", reason: "bearer", allHomes: true }] });
    assert.ok(!res.body.includes(BEARER));
  }
  assert.equal((await local.inject({ method: "GET", url: "/api/agent-profile/daemon-mcp-servers?projectPath=relative" })).statusCode, 400);
  const check = (app: typeof local, payload: unknown) => app.inject({ method: "POST", url: "/api/agent-profile/daemon-mcp-servers/check", payload: payload as Record<string, unknown> });
  assert.equal((await check(remote, { agent: "claude", name: "o" })).statusCode, 404, "the check is socket-only");
  assert.deepEqual((await check(local, { agent: "claude", name: "o", values: ["nothing"] })).json(), { reason: null });
  assert.deepEqual((await check(local, { agent: "claude", id: "mcp:o", name: "o", values: ["nothing"] })).json(), { reason: "bearer" });
  assert.deepEqual((await check(local, { agent: "claude", name: "z", url: "http://localhost:47831/mcp" })).json(), { reason: "url" });
  const bad = await check(local, { agent: "claude", name: "o", values: [1] });
  assert.equal(bad.statusCode, 400);
});

test("a projectPath filter must realpath inside the workspaces root; outside (or through a symlink out) it is refused, never read", async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  const outside = join(fx.root, "outside");
  await write(join(outside, ".mcp.json"), JSON.stringify({ mcpServers: { leak: { url: "http://localhost:47831/mcp" } } }));
  await symlink(outside, join(fx.workspaces, "acme", "escape"));
  const detector = new DaemonMcpDetector(identity(), { homes: fx.homes, accountHomes: async () => [], projects: async () => [], workspacesRoot: () => fx.workspaces });
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  registerDaemonMcpServersRoutes(app, { detector, mode: "local" });
  for (const projectPath of [outside, join(fx.workspaces, "acme", "escape"), fx.workspaces, join(fx.root, "missing")]) {
    const res = await app.inject({ method: "GET", url: `/api/agent-profile/daemon-mcp-servers?projectPath=${encodeURIComponent(projectPath)}` });
    assert.equal(res.statusCode, 400, projectPath);
    assert.ok(!res.body.includes("leak"));
  }
  const inside = await app.inject({ method: "GET", url: `/api/agent-profile/daemon-mcp-servers?projectPath=${encodeURIComponent(fx.project)}` });
  assert.equal(inside.statusCode, 200);
});

test("a chat in a subdirectory: every directory from the project down to its cwd is scanned, nothing outside", async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  const sub = join(fx.project, "packages");
  const cwd = join(sub, "app");
  const sibling = join(fx.project, "docs");
  await mkdir(cwd, { recursive: true });
  const url = "http://localhost:47831/mcp";
  // Claude local scope keyed by the cwd and by the project root; one keyed by a sibling is not loaded.
  await write(fx.homes.claudeJson, JSON.stringify({
    projects: { [cwd]: { mcpServers: { localCwd: { url } } }, [fx.project]: { mcpServers: { localRoot: { url } } }, [sibling]: { mcpServers: { localSibling: { url } } } }
  }));
  await write(join(fx.project, ".mcp.json"), JSON.stringify({ mcpServers: { rootMcp: { url } } }));
  await write(join(sub, ".codex", "config.toml"), `[mcp_servers.subCodex]\nurl = "${url}"\n`);
  await write(join(cwd, "opencode.json"), JSON.stringify({ mcp: { cwdOpencode: { type: "remote", url } } }));
  await write(join(cwd, ".grok", "config.toml"), `[mcp_servers.cwdGrok]\nurl = "${url}"\n`);
  await write(join(sibling, ".mcp.json"), JSON.stringify({ mcpServers: { siblingMcp: { url } } }));
  const detector = new DaemonMcpDetector(identity(), { homes: fx.homes, accountHomes: async () => [], projects: async () => [], workspacesRoot: () => fx.workspaces });
  assert.deepEqual(byKey(await detector.detect({ projectPath: fx.project, cwd })), [
    `claude|system|project|${cwd}|localCwd|url`,
    `claude|system|project|${fx.project}|localRoot|url`,
    `claude|system|project|${fx.project}|rootMcp|url`,
    `codex|system|project|${sub}|subCodex|url`,
    `grok|system|project|${cwd}|cwdGrok|url`,
    `opencode|system|project|${cwd}|cwdOpencode|url`
  ].sort());
  // Without a cwd: the project root's configs only.
  assert.deepEqual(byKey(await detector.detect({ projectPath: fx.project })), [
    `claude|system|project|${fx.project}|localRoot|url`,
    `claude|system|project|${fx.project}|rootMcp|url`
  ].sort());
  // A cwd outside the project (or missing) is refused, never read; cwd needs projectPath.
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  registerDaemonMcpServersRoutes(app, { detector, mode: "local" });
  const get = (query: string) => app.inject({ method: "GET", url: `/api/agent-profile/daemon-mcp-servers?${query}` });
  for (const bad of [fx.other, join(fx.project, "missing"), fx.workspaces]) {
    const res = await get(`projectPath=${encodeURIComponent(fx.project)}&cwd=${encodeURIComponent(bad)}`);
    assert.equal(res.statusCode, 400, bad);
  }
  assert.equal((await get(`cwd=${encodeURIComponent(cwd)}`)).statusCode, 400);
  assert.equal((await get(`projectPath=${encodeURIComponent(fx.project)}&cwd=relative`)).statusCode, 400);
  const ok = await get(`projectPath=${encodeURIComponent(fx.project)}&cwd=${encodeURIComponent(cwd)}`);
  assert.equal(ok.statusCode, 200);
  assert.ok((ok.json() as { servers: DaemonPointingServer[] }).servers.some((server) => server.name === "cwdOpencode"));
});
