/**
 * The daemon user's own agent homes (agent profile spec §3: global only),
 * resolved exactly as each CLI resolves them when the daemon user runs it
 * without a managed account: the same rules `AgentHooks.configTarget`
 * (`agent-hooks.ts`) and `AgentAccountsService.systemClaudeDir` & co.
 * (`agent-accounts.ts`) apply. An empty variable counts as unset, as it does
 * there (`env.X || default`).
 *
 * Paths are returned as resolved, not realpath'd: adapters resolve the
 * realpath of the file they are about to write, at write time (spec §4.5).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentHomes } from "./adapters/types.ts";

export function resolveAgentHomes(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): AgentHomes {
  const claudeConfigDir = env.CLAUDE_CONFIG_DIR || undefined;
  return {
    home,
    claudeDir: claudeConfigDir ?? join(home, ".claude"),
    // Claude keeps `.claude.json` at HOME level unless CLAUDE_CONFIG_DIR moves it into that dir.
    claudeJson: join(claudeConfigDir ?? home, ".claude.json"),
    codexHome: env.CODEX_HOME || join(home, ".codex"),
    grokHome: env.GROK_HOME || join(home, ".grok"),
    opencodeDir: env.OPENCODE_CONFIG_DIR || join(home, ".config", "opencode"),
    agentsSkillsDir: join(home, ".agents", "skills")
  };
}
