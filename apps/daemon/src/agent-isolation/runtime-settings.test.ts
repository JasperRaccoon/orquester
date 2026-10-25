import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseToml } from "../agent-profile/adapters/grok/toml-patch.ts";
import { parseJsoncObject } from "../agent-profile/adapters/opencode/jsonc.ts";
import {
  claudeRuntimeSettings,
  codexRuntimeConfig,
  grokRuntimeConfig,
  opencodeRuntimeConfig
} from "./runtime-settings.ts";

describe("claudeRuntimeSettings", () => {
  const settings = {
    $schema: "https://json.schemastore.org/claude-code-settings.json",
    model: "opus",
    env: { FOO: "1" },
    permissions: { allow: ["Bash(git status)"], deny: ["Read(.env)"], defaultMode: "acceptEdits" },
    apiKeyHelper: "/bin/key-helper",
    statusLine: { type: "command", command: "~/status.sh" },
    outputStyle: "Explanatory",
    enableAllProjectMcpServers: true,
    enabledMcpjsonServers: ["repo-server"],
    allowedMcpServers: [{ serverName: "ok" }],
    deniedMcpServers: [{ serverName: "globally-off" }, { serverUrl: "https://evil.example/*" }],
    claudeMdExcludes: ["**/vendor/CLAUDE.md"],
    someFutureKey: { nested: [1, 2] },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] },
    disableAllHooks: true,
    enabledPlugins: { "a@b": true },
    extraKnownMarketplaces: { b: { source: { source: "github", repo: "o/r" } } },
    additionalMarketplaces: {},
    prependPlugins: [],
    appendPlugins: [],
    pluginConfigs: { "a@b": { mcpServers: {} } },
    pluginSuggestionMarketplaces: [],
    skillOverrides: { pdf: "off" },
    disableBundledSkills: true,
    syncClaudeAiSkills: true,
    syncClaudeAiPlugins: true,
    disableClaudeAiConnectors: false,
    allowAllClaudeAiMcps: true,
    managedMcpServers: { m: { type: "http", url: "https://x" } },
    autoMemoryEnabled: true,
    autoMemoryDirectory: "~/mem",
    autoDreamEnabled: true,
    claudeMd: "be nice",
    agent: "my-agent"
  };

  it("keeps runtime settings and unknown keys, drops every item key", () => {
    const out = claudeRuntimeSettings(settings);
    assert.deepEqual(out, {
      $schema: settings.$schema,
      model: "opus",
      env: { FOO: "1" },
      permissions: settings.permissions,
      apiKeyHelper: "/bin/key-helper",
      statusLine: settings.statusLine,
      outputStyle: "Explanatory",
      enableAllProjectMcpServers: true,
      enabledMcpjsonServers: ["repo-server"],
      allowedMcpServers: [{ serverName: "ok" }],
      deniedMcpServers: [{ serverUrl: "https://evil.example/*" }],
      claudeMdExcludes: ["**/vendor/CLAUDE.md"],
      someFutureKey: { nested: [1, 2] }
    });
  });

  it("removes deniedMcpServers when only serverName entries were there", () => {
    assert.deepEqual(claudeRuntimeSettings({ deniedMcpServers: [{ serverName: "a" }], model: "x" }), { model: "x" });
  });

  it("copies deeply and leaves the input untouched", () => {
    const input = { env: { A: "1" }, hooks: {} };
    const out = claudeRuntimeSettings(input);
    (out.env as Record<string, string>).A = "2";
    assert.deepEqual(input, { env: { A: "1" }, hooks: {} });
  });
});

describe("codexRuntimeConfig", () => {
  const text = `
model = "gpt-5.5"
model_provider = "openai"
model_reasoning_effort = "high"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
notify = ["notify-send", "codex"]
developer_instructions = "always be terse"
model_instructions_file = "~/instr.md"
sqlite_home = "/somewhere"
future_key = 42

[features]
apps = true
plugins = true

[projects."/srv/repo"]
trust_level = "trusted"

[model_providers.local]
name = "Local"
base_url = "http://localhost:1234/v1"

[mcp_servers.jira]
command = "jira-mcp"

[plugins."github@openai-curated"]
enabled = true

[marketplaces.mine]
source_type = "local"
source = "/x"

[[skills.config]]
path = "/home/u/.agents/skills/pdf/SKILL.md"
enabled = false

[skills.bundled]
enabled = true

[hooks.state."/home/u/.codex/hooks.json:stop:0:0"]
trusted_hash = "sha256:abc"

[apps.slack]
enabled = false

[agents]
max_threads = 6

[agents.reviewer]
description = "reviews"
config_file = "agents/reviewer.toml"

[profiles.fast]
model = "gpt-5.5-mini"
developer_instructions = "x"

[profiles.fast.mcp_servers.extra]
command = "extra"

[tui]
theme = "dark"
`;

  it("keeps trust entries, models, policy, profiles and unknown keys; drops item sections", () => {
    const out = codexRuntimeConfig(parseToml(text));
    assert.deepEqual(out, {
      model: "gpt-5.5",
      model_provider: "openai",
      model_reasoning_effort: "high",
      approval_policy: "on-request",
      sandbox_mode: "workspace-write",
      notify: ["notify-send", "codex"],
      future_key: 42,
      features: { apps: true, plugins: true },
      projects: { "/srv/repo": { trust_level: "trusted" } },
      model_providers: { local: { name: "Local", base_url: "http://localhost:1234/v1" } },
      agents: { max_threads: 6 },
      profiles: { fast: { model: "gpt-5.5-mini" } },
      tui: { theme: "dark" }
    });
  });
});

describe("grokRuntimeConfig", () => {
  it("drops MCP servers, plugins, skills, hooks and compat; keeps the rest", () => {
    const text = `
disabled_mcp_servers = ["from-claude"]

[cli]
auto_update = true
installer = "npm"

[ui]
yolo = false
permission_mode = "default"

[marketplace]
official_marketplace_auto_installed = true

[[marketplace.sources]]
name = "official"

[plugins]
enabled = ["hookify"]

[skills]
disabled = ["pdf"]

[compat.claude]
hooks = false

[mcp_servers.jira]
command = "jira"

[hooks]
x = 1
`;
    const out = grokRuntimeConfig(parseToml(text));
    assert.deepEqual(out, {
      cli: { auto_update: true, installer: "npm" },
      ui: { yolo: false, permission_mode: "default" },
      marketplace: { official_marketplace_auto_installed: true, sources: [{ name: "official" }] }
    });
  });
});

describe("opencodeRuntimeConfig", () => {
  it("drops mcp, plugin, instructions, command, agent and skill paths; keeps provider, model, permission", () => {
    const parsed = parseJsoncObject(`{
      // comment
      "$schema": "https://opencode.ai/config.json",
      "provider": { "anthropic": { "options": { "baseURL": "https://x" } } },
      "model": "anthropic/claude",
      "small_model": "anthropic/haiku",
      "permission": { "bash": "ask", "skill": { "*": "allow" } },
      "autoupdate": false,
      "experimental": { "mcp_timeout": 5 },
      "mcp": { "jira": { "type": "local", "command": ["jira"] } },
      "plugin": ["opencode-foo"],
      "instructions": ["~/rules.md"],
      "command": { "review": { "template": "x" } },
      "agent": { "build": { "model": "x" } },
      "mode": { "plan": {} },
      "default_agent": "mine",
      "skills": { "paths": ["~/skills"] },
      "references": { "docs": "https://x" },
      "brand_new": true,
    }`);
    assert.ok(parsed.ok);
    const out = opencodeRuntimeConfig(parsed.value);
    assert.deepEqual(out, {
      $schema: "https://opencode.ai/config.json",
      provider: { anthropic: { options: { baseURL: "https://x" } } },
      model: "anthropic/claude",
      small_model: "anthropic/haiku",
      permission: { bash: "ask", skill: { "*": "allow" } },
      autoupdate: false,
      experimental: { mcp_timeout: 5 },
      brand_new: true
    });
  });
});
