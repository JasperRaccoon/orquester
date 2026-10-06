// One critical assembled workflow: public MCP calls persist native configuration while secrets remain host-only.
// Lower owner tests cover individual draft rules, conflicts, imports and native adapter mutations.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { agentProfileBackupsDir, agentProfileImportsDir, agentProfileStashDir } from "@orquester/config";
import { Broadcaster } from "../broadcaster.ts";
import { InjectDaemonApi } from "../mcp/daemon-api.ts";
import { registerMcp } from "../mcp/server.ts";
import type { AgentHomes } from "./adapters/types.ts";
import { OpenCodeProfileAdapter } from "./adapters/opencode/index.ts";
import { createProfileConverter } from "./convert.ts";
import { ProfileBackups, ProfileStash } from "./infra/index.ts";
import { registerAgentProfileRoutes } from "./routes.ts";
import { AgentProfileService } from "./service.ts";

test("MCP profile creation and partial edits persist secrets without returning them", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orq-profile-mcp-e2e-")));
  let app: FastifyInstance | undefined;
  let mcp: FastifyInstance | undefined;
  let service: AgentProfileService | undefined;
  t.after(async () => {
    await mcp?.close();
    await app?.close();
    await service?.stop();
    await rm(root, { recursive: true, force: true });
  });

  const home = join(root, "home");
  const appdir = join(root, "appdir");
  const opencodeDir = join(home, ".config", "opencode");
  const config = join(opencodeDir, "opencode.jsonc");
  await mkdir(opencodeDir, { recursive: true });
  await writeFile(config, "{}\n");
  const homes: AgentHomes = {
    home,
    claudeDir: join(home, ".claude"),
    claudeJson: join(home, ".claude.json"),
    codexHome: join(home, ".codex"),
    grokHome: join(home, ".grok"),
    opencodeDir,
    agentsSkillsDir: join(home, ".agents", "skills")
  };
  const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const opencode = new OpenCodeProfileAdapter(
    { homes, appdir, bin: "/unused/opencode", accountHomes: async () => [], logger: quiet, now: () => new Date() },
    { backups: new ProfileBackups({ dir: agentProfileBackupsDir(appdir) }), stash: new ProfileStash({ dir: agentProfileStashDir(appdir) }) }
  );
  service = new AgentProfileService({
    adapters: { opencode }, agentInfo: (agent) => ({ installed: agent === "opencode" }), homes, logger: quiet,
    converter: createProfileConverter({ tempRoot: agentProfileImportsDir(appdir) })
  });
  app = Fastify({ logger: false });
  registerAgentProfileRoutes(app, { service, importsDir: agentProfileImportsDir(appdir) });
  await app.ready();
  const api = new InjectDaemonApi({ app, authorization: undefined, agentChat: null, broadcaster: new Broadcaster(), fsRoot: root, workspacesDir: root });
  mcp = Fastify({ logger: false });
  registerMcp(mcp, { createApi: () => api, todos: {} as never, files: {} as never });
  const address = await mcp.listen({ host: "127.0.0.1", port: 0 });

  const token = "e2e-SECRET-token-0001";
  const email = "e2e-SECRET-email-0002";
  const region = "e2e-SECRET-region-0003";
  const urlSecret = "e2e-SECRET-url-0005";
  let requestId = 0;
  async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(`${address}/mcp`, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: args } })
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    for (const secret of [token, email, region, urlSecret]) assert.ok(!text.includes(secret), `${name} returned a secret`);
    const envelope = JSON.parse(text);
    assert.equal(envelope.error, undefined, text);
    assert.notEqual(envelope.result?.isError, true, text);
    assert.ok(envelope.result?.structuredContent, text);
    return envelope.result.structuredContent;
  }

  await call("create_agent_profile_item", {
    agent: "opencode",
    mcp: { name: "jira", command: "node", args: ["/srv/jira/index.js"], env: { JIRA_API_TOKEN: token, JIRA_EMAIL: email }, advanced: { timeout: 60000 } }
  });
  assert.deepEqual(JSON.parse(await readFile(config, "utf8")).mcp.jira.environment, { JIRA_API_TOKEN: token, JIRA_EMAIL: email });

  await call("update_agent_profile_item", {
    agent: "opencode", id: "mcp:jira", mcp: { env: { JIRA_EMAIL: null, JIRA_REGION: region } }
  });
  const nativeConfig = JSON.parse(await readFile(config, "utf8"));
  assert.deepEqual(nativeConfig.mcp.jira, {
    type: "local", command: ["node", "/srv/jira/index.js"], environment: { JIRA_API_TOKEN: token, JIRA_REGION: region }, timeout: 60000
  });
  const detail = await call("get_agent_profile_item", { agent: "opencode", id: "mcp:jira" });
  const view = detail.mcp as { env: { key: string; set: boolean }[] };
  assert.deepEqual([...view.env].sort((a, b) => a.key.localeCompare(b.key)), [
    { key: "JIRA_API_TOKEN", set: true },
    { key: "JIRA_REGION", set: true }
  ]);

  const id = "mcp:remote-credentials";
  const url = `https://user:first@${urlSecret}@mcp.example/x?view=1`;
  const redacted = "https://***@mcp.example/x?view=1";
  const created = await call("create_agent_profile_item", {
    agent: "opencode", mcp: { name: "remote-credentials", transport: "http", url }
  });
  assert.ok((await readFile(config, "utf8")).includes(JSON.stringify(url)), "creation preserves the original URL bytes");

  const remote = await call("get_agent_profile_item", { agent: "opencode", id });
  assert.equal((remote.mcp as { url: string }).url, redacted, "the editable detail hides the complete userinfo");
  const listed = await call("get_agent_profile", { agent: "opencode", kind: "mcp", query: "remote-credentials" });
  const updated = await call("update_agent_profile_item", { agent: "opencode", id, mcp: { advanced: { timeout: 2500 } } });
  assert.ok((await readFile(config, "utf8")).includes(JSON.stringify(url)), "an update without url preserves its original bytes");

  for (const [operation, result] of [["create", created], ["get", remote], ["list", listed], ["update", updated]] as const) {
    const item = (result.item ?? (result.items as Record<string, unknown>[]).find((entry) => entry.id === id)) as { meta?: { url?: string } } | undefined;
    assert.equal(item?.meta?.url, redacted, `${operation}: summary metadata hides the complete userinfo`);
  }

  const artifactDir = await mkdtemp(join(tmpdir(), "orq-profile-mcp-artifact-"));
  const artifact = join(artifactDir, "result.json");
  await writeFile(artifact, JSON.stringify({
    workflow: "MCP profile create and partial update",
    checks: ["native secret values persisted", "partial update preserved omitted secrets", "responses omitted secrets", "URL userinfo redacted"],
    detail, remote, listed, updated
  }, null, 2), { mode: 0o600 });
  t.diagnostic(`Verified artifact: ${artifact}`);
});
