/**
 * Test fixture for Grok's preparer and launch (not a test itself): a fake daemon-user HOME with a
 * Global `~/.grok` (a `config.toml` with runtime settings AND item sections, shared `sessions/`
 * and `trusted_folders.toml`) and `~/.claude/skills` holding a real, a symlinked and a dangling
 * entry; a profile source — instructions, a skill, a nested command, a Grok plugin in the
 * profile's cache, MCP servers with secret values, hooks — and the {@link ResolvedAgentProfile}
 * `resolveForAgent` would answer for it, plus a prepare context.
 */

import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentHomes } from "../../agent-profile/adapters/types.ts";
import type { SessionProfilePrepareContext } from "../preparer.ts";
import type { ResolvedAgentProfile } from "../resolve.ts";

export const GROK_FIXTURE_SECRETS = { env: "sekret-grok-env-1", header: "Bearer sekret-grok-header-2" };

export const GROK_FIXTURE_GLOBAL_CONFIG = `[cli]
installer = "npm"
auto_update = true

[ui]
permission_mode = "always-approve"

[marketplace]
official_marketplace_auto_installed = true

[[marketplace.sources]]
name = "xAI Official"
git = "https://github.com/xai-org/plugin-marketplace.git"

[compat.claude]
hooks = false

[plugins]
enabled = ["superpowers"]

[skills]
disabled = ["x"]

[mcp_servers.global-one]
command = "global-mcp"

[future_section]
keep = "me"
`;

export interface GrokProfileFixture {
  root: string;
  home: string;
  globalHome: string;
  appdir: string;
  resolved: ResolvedAgentProfile;
  pluginCacheDir: string;
  context(input: { stagingDir: string; preparedDir: string }): SessionProfilePrepareContext<"grok">;
  warnings: string[];
}

async function write(path: string, text: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}

export async function makeGrokProfileFixture(
  root: string,
  settings: Partial<ResolvedAgentProfile["settings"]> = {}
): Promise<GrokProfileFixture> {
  const home = join(root, "home");
  const globalHome = join(home, ".grok");
  await write(join(globalHome, "config.toml"), GROK_FIXTURE_GLOBAL_CONFIG);
  await mkdir(join(globalHome, "sessions"), { recursive: true });
  await write(join(globalHome, "trusted_folders.toml"), "");
  // ~/.claude/skills: a real entry, a symlinked one (Grok follows it) and a dangling link.
  await write(join(home, ".claude", "skills", "real-one", "SKILL.md"), "---\nname: real-one\n---\n");
  await write(join(root, "shared-skills", "linked-one", "SKILL.md"), "---\nname: linked-one\n---\n");
  await symlink(join(root, "shared-skills", "linked-one"), join(home, ".claude", "skills", "linked-one"));
  await symlink(join(root, "gone"), join(home, ".claude", "skills", "dangling"));

  const profileDir = join(root, "profile");
  const skillDir = join(profileDir, "skills", "sk1");
  await write(join(skillDir, "SKILL.md"), "---\nname: review\ndescription: Review code\n---\nReview it.\n");
  await write(join(skillDir, "notes.md"), "notes\n");
  const commandFile = join(profileDir, "commands", "c1.md");
  await write(commandFile, "---\ndescription: Open a PR\n---\nOpen a PR.\n");
  const pluginCacheDir = join(profileDir, "plugins", "pl1");
  await write(join(pluginCacheDir, ".grok-plugin", "plugin.json"), `${JSON.stringify({ name: "toolbox", version: "1.2.0" })}\n`);
  await write(join(pluginCacheDir, "skills", "lint", "SKILL.md"), "---\nname: lint\ndescription: Lint\n---\nLint.\n");

  const warnings: string[] = [];
  const resolved: ResolvedAgentProfile = {
    profileId: "p1",
    revision: "4",
    name: "Dev Kit",
    agent: "grok",
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
        env: { API_KEY: GROK_FIXTURE_SECRETS.env },
        headers: {},
        advanced: { startup_timeout_sec: 20, unknown_key: 1 }
      },
      {
        id: "m2",
        name: "docs",
        transport: "sse",
        url: "https://docs.example/sse",
        env: {},
        headers: { Authorization: GROK_FIXTURE_SECRETS.header },
        advanced: {}
      },
      { id: "m3", name: "orquester", transport: "stdio", command: "fake", env: {}, headers: {}, advanced: {} }
    ],
    hooks: [
      { id: "h1", name: "pre", event: "PreToolUse", matcher: "Bash", command: "echo pre", timeoutSec: 5 },
      { id: "h2", name: "stop", event: "Stop", command: "echo stop" }
    ],
    plugins: [{ id: "pl1", name: "toolbox-item", marketplace: "mkt", cacheDir: pluginCacheDir }],
    skipped: []
  };

  const systemHomes: AgentHomes = {
    home,
    claudeDir: join(home, ".claude"),
    claudeJson: join(home, ".claude.json"),
    codexHome: join(home, ".codex"),
    grokHome: globalHome,
    opencodeDir: join(home, ".config", "opencode"),
    agentsSkillsDir: join(home, ".agents", "skills")
  };
  const appdir = join(root, "appdir");
  return {
    root,
    home,
    globalHome,
    appdir,
    resolved,
    pluginCacheDir,
    warnings,
    context: ({ stagingDir, preparedDir }) => ({
      resolved,
      agent: "grok",
      accountKey: "shared",
      accountHome: null,
      systemHomes,
      stagingDir,
      preparedDir,
      previousPreparedDir: null,
      appdir,
      logger: { info: () => {}, warn: (message) => warnings.push(message) }
    })
  };
}
