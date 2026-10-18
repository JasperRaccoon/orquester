/**
 * Test fixture for Claude's preparer and launch (not a test itself): a profile source on disk —
 * a skill with an extra file, a nested command, a Claude plugin in the profile's cache with its
 * own skill, command and `.mcp.json`, MCP servers with secret values, hooks and instructions — and
 * the {@link ResolvedAgentProfile} `resolveForAgent` would answer for it, plus a prepare context.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentHomes } from "../../agent-profile/adapters/types.ts";
import type { SessionProfilePrepareContext } from "../preparer.ts";
import type { ResolvedAgentProfile } from "../resolve.ts";

export const FIXTURE_SECRETS = { env: "sekret-env-value-1", header: "Bearer sekret-header-value-2" };

export interface ClaudeProfileFixture {
  root: string;
  resolved: ResolvedAgentProfile;
  pluginCacheDir: string;
  context(input: { stagingDir: string; preparedDir: string }): SessionProfilePrepareContext<"claude">;
  warnings: string[];
}

async function write(path: string, text: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}

export async function makeClaudeProfileFixture(
  root: string,
  settings: Partial<ResolvedAgentProfile["settings"]> = {}
): Promise<ClaudeProfileFixture> {
  const profileDir = join(root, "profile");
  const skillDir = join(profileDir, "skills", "sk1");
  await write(join(skillDir, "SKILL.md"), "---\nname: review\ndescription: Review code\n---\nReview it.\n");
  await write(join(skillDir, "notes.md"), "notes\n");
  const commandFile = join(profileDir, "commands", "c1.md");
  await write(commandFile, "---\ndescription: Open a PR\n---\nOpen a PR.\n");

  const pluginCacheDir = join(profileDir, "plugins", "pl1");
  await write(join(pluginCacheDir, ".claude-plugin", "plugin.json"), `${JSON.stringify({ name: "toolbox", version: "1.2.0" })}\n`);
  await write(join(pluginCacheDir, "skills", "lint", "SKILL.md"), "---\nname: lint\ndescription: Lint\n---\nLint.\n");
  await write(join(pluginCacheDir, "commands", "fmt.md"), "---\ndescription: Format\n---\nFormat.\n");
  await write(join(pluginCacheDir, "bin", "db"), "#!/bin/sh\n");
  await write(
    join(pluginCacheDir, ".mcp.json"),
    `${JSON.stringify({ mcpServers: { db: { command: "${CLAUDE_PLUGIN_ROOT}/bin/db", args: ["--data", "${CLAUDE_PLUGIN_DATA}", "${HOME}"] } } })}\n`
  );

  const warnings: string[] = [];
  const resolved: ResolvedAgentProfile = {
    profileId: "p1",
    revision: "3",
    name: "Dev Kit",
    agent: "claude",
    settings: { hideBuiltinSkills: true, claudeWorkflowTool: true, ...settings },
    instructions: "Be brief.\n",
    skills: [{ id: "sk1", name: "review", description: "Review code", dir: skillDir, skillFile: join(skillDir, "SKILL.md") }],
    commands: [{ id: "c1", name: "git/pr", description: "Open a PR", file: commandFile }],
    mcpServers: [
      {
        id: "m1",
        name: "search",
        transport: "stdio",
        command: "search-mcp",
        args: ["--fast"],
        env: { API_KEY: FIXTURE_SECRETS.env },
        headers: {},
        advanced: {}
      },
      {
        id: "m2",
        name: "docs",
        transport: "http",
        url: "https://docs.example/mcp",
        env: {},
        headers: { Authorization: FIXTURE_SECRETS.header },
        advanced: { timeout: 5000 }
      },
      { id: "m3", name: "orquester", transport: "stdio", command: "fake", env: {}, headers: {}, advanced: {} }
    ],
    hooks: [
      { id: "h1", name: "pre", event: "PreToolUse", matcher: "Bash", command: "echo pre", timeoutSec: 5 },
      { id: "h2", name: "pre2", event: "PreToolUse", matcher: "Bash", command: "echo two" },
      { id: "h3", name: "stop", event: "Stop", command: "echo stop" }
    ],
    plugins: [{ id: "pl1", name: "toolbox-item", marketplace: "mkt", version: "1.2.0", cacheDir: pluginCacheDir }],
    skipped: []
  };

  const home = join(root, "home");
  const systemHomes: AgentHomes = {
    home,
    claudeDir: join(home, ".claude"),
    claudeJson: join(home, ".claude.json"),
    codexHome: join(home, ".codex"),
    grokHome: join(home, ".grok"),
    opencodeDir: join(home, ".config", "opencode"),
    agentsSkillsDir: join(home, ".agents", "skills")
  };
  return {
    root,
    resolved,
    pluginCacheDir,
    warnings,
    context: ({ stagingDir, preparedDir }) => ({
      resolved,
      agent: "claude",
      accountKey: "shared",
      accountHome: null,
      systemHomes,
      stagingDir,
      preparedDir,
      previousPreparedDir: null,
      appdir: join(root, "appdir"),
      logger: { info: () => {}, warn: (message) => warnings.push(message) }
    })
  };
}
