/**
 * Agent isolation — per-agent, profile-agnostic primitives for preparing an
 * Agent Profile chat (spec §6). Plain inputs and outputs; see README.md.
 */

export {
  CLAUDE_DROPPED_SETTINGS,
  CODEX_DROPPED_CONFIG,
  GROK_DROPPED_CONFIG,
  OPENCODE_DROPPED_CONFIG,
  claudeRuntimeSettings,
  codexRuntimeConfig,
  grokRuntimeConfig,
  opencodeRuntimeConfig
} from "./runtime-settings.ts";
export {
  CODEX_STATE_DB_FILE,
  type SeedCodexHomeOptions,
  type SeedCodexHomeResult,
  codexStateDbPresent,
  seedCodexHome
} from "./codex-seed.ts";
export {
  GROK_PROFILE_ENV,
  GROK_USER_SKILL_ROOTS,
  type GrokPluginNamesResult,
  type GrokProfileConfigInput,
  grokDiscoveredPluginNames,
  grokProfileConfig,
  grokSkillIgnoreList,
  parsePluginNames,
  renderGrokProfileConfigToml
} from "./grok.ts";
export { type XdgShadowResult, buildXdgConfigShadow } from "./xdg-shadow.ts";
export {
  type ClaudeLocalPlugin,
  type ClaudeLocalPluginInput,
  generateClaudeLocalPlugin
} from "./claude-plugin.ts";
