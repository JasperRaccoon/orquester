import assert from "node:assert/strict";
import { test } from "node:test";

import { codexBoxMcpOverrides, codexSessionToolsConfig } from "../adapters/codex/session-tools.ts";
import { grokSessionMcpServers } from "../adapters/grok/session-tools.ts";
import { claudeMcpSpec, isLoopbackUrl, openCodeMcpSpec, planMcpBridges, tomlMcpSpec } from "./mcp-plan.ts";

const sys = { agentPath: "/opt/orq-agent" };
let seq = 0;
const newServerId = (): string => `server-${String(++seq).padStart(8, "0")}`;

test("each CLI's config shape reads into one spec; disabled and in-process entries are not servers", () => {
  assert.deepEqual(claudeMcpSpec("gh", { command: "gh-mcp", args: ["--stdio"], env: { T: "x" } }), {
    name: "gh",
    transport: "stdio",
    command: "gh-mcp",
    args: ["--stdio"],
    env: { T: "x" }
  });
  assert.deepEqual(claudeMcpSpec("web", { type: "http", url: "https://x/mcp", headers: { A: "b" } }), {
    name: "web",
    transport: "http",
    url: "https://x/mcp",
    headers: { A: "b" }
  });
  assert.equal(claudeMcpSpec("orq", { type: "sdk", name: "orq" }), null);
  // Codex: `env_vars` and `bearer_token_env_var` name the CLI's own variables.
  assert.deepEqual(tomlMcpSpec("gh", { command: "gh-mcp", env_vars: ["GH_TOKEN"] }, { GH_TOKEN: "ghp" }), {
    name: "gh",
    transport: "stdio",
    command: "gh-mcp",
    args: [],
    env: { GH_TOKEN: "ghp" }
  });
  assert.deepEqual(tomlMcpSpec("api", { url: "http://localhost:9/mcp", bearer_token_env_var: "API" }, { API: "k" })?.headers, { Authorization: "Bearer k" });
  assert.equal(tomlMcpSpec("off", { command: "x", enabled: false }), null);
  assert.deepEqual(openCodeMcpSpec("gh", { type: "local", command: ["gh-mcp", "--stdio"], environment: { T: "x" } }), {
    name: "gh",
    transport: "stdio",
    command: "gh-mcp",
    args: ["--stdio"],
    env: { T: "x" }
  });
});

test("the plan: stdio, loopback and secret-header servers are bridged; internet ones go direct; Run in box stays", () => {
  assert.equal(isLoopbackUrl("http://127.0.0.1:3000/mcp"), true);
  assert.equal(isLoopbackUrl("http://[::1]:3000/mcp"), true);
  assert.equal(isLoopbackUrl("http://app.localhost/mcp"), true);
  assert.equal(isLoopbackUrl("https://mcp.example.com/mcp"), false);
  const plan = planMcpBridges(
    [
      { name: "stdio", transport: "stdio", command: "s" },
      { name: "loop", transport: "http", url: "http://localhost:7/mcp", headers: {} },
      { name: "secret", transport: "sse", url: "https://mcp.example.com/sse", headers: { Authorization: "Bearer t" } },
      { name: "public", transport: "http", url: "https://mcp.example.com/mcp", headers: {} },
      { name: "linter", transport: "stdio", command: "lint-mcp" }
    ],
    { runInBox: new Set(["linter"]), sys, newServerId }
  );
  assert.deepEqual(plan.bridged.map((s) => [s.name, s.target.transport]), [["stdio", "stdio"], ["loop", "http"], ["secret", "sse"]]);
  assert.deepEqual(plan.bridged[0]?.args, ["mcp-bridge", plan.bridged[0]?.serverId]);
  assert.deepEqual(plan.direct.map((s) => s.name), ["public"]);
  assert.deepEqual(plan.inBox.map((s) => s.name), ["linter"]);
});

test("Codex box overrides: a stdio server keeps its name, its env blanked; an HTTP one is switched off and bridged beside", () => {
  const overrides = codexBoxMcpOverrides([
    { name: "gh", command: "/opt/orq-agent", args: ["mcp-bridge", "id1"], transport: "stdio", envKeys: ["GH_TOKEN"] },
    { name: "local", command: "/opt/orq-agent", args: ["mcp-bridge", "id2"], transport: "http", envKeys: [] }
  ]);
  const config = codexSessionToolsConfig(
    { url: "http://127.0.0.1:41000/mcp", instructions: "", bridge: { command: "/opt/orq-agent", args: ["mcp-bridge", "id0"] } },
    overrides
  );
  // Ours rides the bridge: no URL and no bearer variable reach the box.
  assert.deepEqual(config["mcp_servers.orquester"], {
    command: "/opt/orq-agent",
    args: ["mcp-bridge", "id0"],
    default_tools_approval_mode: "approve",
    tool_timeout_sec: (config["mcp_servers.orquester"] as { tool_timeout_sec: number }).tool_timeout_sec
  });
  assert.deepEqual(config["mcp_servers.gh"], { command: "/opt/orq-agent", args: ["mcp-bridge", "id1"], env: { GH_TOKEN: "" }, env_vars: [] });
  assert.equal(config["mcp_servers.local.enabled"], false);
  assert.deepEqual(config["mcp_servers.local_host"], { command: "/opt/orq-agent", args: ["mcp-bridge", "id2"] });
});

test("Grok in a box: ours and the user's host-run servers are stdio entries of the bridge; a denial's shadow still wins its name", () => {
  const servers = grokSessionMcpServers(
    {
      url: "http://127.0.0.1:41000/mcp",
      authorization: "Bearer cred",
      instructions: "",
      toolNames: new Set(),
      deny: ["blocked"],
      deniedUrl: "http://127.0.0.1:41000/mcp/denied"
    },
    {
      sessionToolsBridge: { command: "/opt/orq-agent", args: ["mcp-bridge", "id0"] },
      bridged: [
        { name: "gh", command: "/opt/orq-agent", args: ["mcp-bridge", "id1"], env: [] },
        { name: "blocked", command: "/opt/orq-agent", args: ["mcp-bridge", "id2"], env: [] }
      ]
    }
  );
  assert.deepEqual(servers, [
    { name: "orquester", command: "/opt/orq-agent", args: ["mcp-bridge", "id0"], env: [] },
    { type: "http", name: "blocked", url: "http://127.0.0.1:41000/mcp/denied", headers: [] },
    { name: "gh", command: "/opt/orq-agent", args: ["mcp-bridge", "id1"], env: [] }
  ]);
  assert.equal(JSON.stringify(servers).includes("Bearer cred"), false);
});
