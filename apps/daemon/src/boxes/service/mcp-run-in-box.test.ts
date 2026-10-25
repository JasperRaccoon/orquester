import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { boxRoutes, type AgentProfileAgentId, type BoxMcpRunInBoxResponse } from "@orquester/api";
import Fastify from "fastify";

import { registerBoxMcpRunInBoxRoutes } from "./mcp-run-in-box.ts";

// "Run in box" for Agent config's MCP servers: the list comes from each agent's snapshot, the
// switches from box-mcp.json, and a PUT changes one switch while keeping everything else.

const SNAPSHOTS: Partial<Record<AgentProfileAgentId, { installed: boolean; items: { kind: string; name: string }[] }>> = {
  claude: { installed: true, items: [{ kind: "mcp", name: "github" }, { kind: "skill", name: "review" }, { kind: "mcp", name: "postgres" }] },
  codex: { installed: true, items: [{ kind: "mcp", name: "github" }] },
  grok: { installed: false, items: [{ kind: "mcp", name: "ignored" }] }
};

async function harness(t: test.TestContext, options: { enabled?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "orq-box-mcp-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "box-mcp.json");
  const app = Fastify();
  registerBoxMcpRunInBoxRoutes(app, {
    file,
    snapshot: async (agent) => SNAPSHOTS[agent] ?? { installed: false, items: [] },
    writeJson: (path, value) => writeFile(path, JSON.stringify(value)),
    enabled: () => options.enabled ?? true
  });
  t.after(() => app.close());
  return { app, file };
}

test("GET lists every installed agent's MCP servers with their switch", async (t) => {
  const { app, file } = await harness(t);
  await writeFile(file, JSON.stringify({ version: 1, agents: { claude: { postgres: { runInBox: true } } }, extra: 1 }));
  const response = await app.inject({ method: "GET", url: boxRoutes.mcpRunInBox });
  assert.equal(response.statusCode, 200);
  assert.deepEqual((response.json() as BoxMcpRunInBoxResponse).servers, [
    { name: "github", agent: "claude", runInBox: false },
    { name: "postgres", agent: "claude", runInBox: true },
    { name: "github", agent: "codex", runInBox: false }
  ]);
});

test("PUT sets one switch and keeps unknown fields", async (t) => {
  const { app, file } = await harness(t);
  await writeFile(file, JSON.stringify({ version: 1, agents: { claude: { postgres: { runInBox: true, note: "x" } } }, extra: 1 }));
  const response = await app.inject({ method: "PUT", url: boxRoutes.mcpRunInBox, payload: { agent: "codex", name: "github", runInBox: true } });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(
    (response.json() as BoxMcpRunInBoxResponse).servers.find((server) => server.agent === "codex"),
    { name: "github", agent: "codex", runInBox: true }
  );
  const stored = JSON.parse(await readFile(file, "utf8"));
  assert.equal(stored.extra, 1);
  assert.deepEqual(stored.agents.claude.postgres, { runInBox: true, note: "x" });
  assert.deepEqual(stored.agents.codex.github, { runInBox: true });
  const disabled = await app.inject({ method: "PUT", url: boxRoutes.mcpRunInBox, payload: { agent: "codex", name: "github", runInBox: false } });
  assert.equal(disabled.statusCode, 200);
  assert.equal(JSON.parse(await readFile(file, "utf8")).agents.codex.github.runInBox, false);
});

test("PUT is refused while the plugin is off and for a bad body", async (t) => {
  const off = await harness(t, { enabled: false });
  const refused = await off.app.inject({ method: "PUT", url: boxRoutes.mcpRunInBox, payload: { agent: "claude", name: "github", runInBox: true } });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().code, "BOXES_DISABLED");

  const on = await harness(t);
  for (const payload of [
    { agent: "opencode", name: "github", runInBox: true },
    { agent: "grok", name: "", runInBox: false },
    { agent: "grok", name: "a\nb", runInBox: false },
    { agent: "grok", name: "x", runInBox: "yes" },
    "null"
  ]) {
    const bad = await on.app.inject({ method: "PUT", url: boxRoutes.mcpRunInBox, headers: { "content-type": "application/json" }, payload });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().code, "BOX_INVALID_REQUEST");
  }
});
