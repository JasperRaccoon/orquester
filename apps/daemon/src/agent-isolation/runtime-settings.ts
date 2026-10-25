/**
 * Agent isolation — runtime settings carried over from an agent's GLOBAL
 * config into a profile chat (spec §6.0).
 *
 * Each filter takes the agent's parsed global config and answers a deep copy
 * with the "item" sections removed: what reaches the model's context
 * (instructions, skills, MCP servers, plugins, hooks, commands, agents,
 * memory) or decides which of the user's global items are on. Everything else
 * — model/provider definitions, approval/sandbox/permission policy, env, auth
 * helpers, status line, notify, trust entries — is kept, and so is every key
 * this file does not know: a key is a runtime setting until shown otherwise.
 *
 * The filters never mutate their input and never add keys; the recipe's own
 * keys are merged over the result by the caller (the recipe wins).
 *
 * Key lists were fixed from the CLIs installed here: the Claude Agent SDK
 * 0.3.278 `Settings` type (`sdk.d.ts`), codex-cli 0.159.0 (the v2 `Config`
 * bindings and the binary's config strings), Grok 1.0.46 (`config.toml` as it
 * writes it, the binary's config reference) and the OpenCode SDK's v2 `Config`
 * type.
 */

type Doc = Record<string, unknown>;

function isPlainObject(value: unknown): value is Doc {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** A deep copy of `doc` without the top-level `drop` keys. */
function without(doc: Doc, drop: ReadonlySet<string>): Doc {
  const out: Doc = {};
  for (const [key, value] of Object.entries(doc)) {
    if (!drop.has(key)) {
      out[key] = structuredClone(value);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Claude — user `settings.json` → SDK `settings` (flag tier)
// ---------------------------------------------------------------------------

/**
 * Top-level `settings.json` keys a profile chat does NOT inherit, and why.
 * Kept on purpose (runtime/policy, not items): `permissions`, `env`, `model`
 * and friends, `apiKeyHelper` and the other auth helpers, `statusLine`,
 * `outputStyle`, `language`, `enableAllProjectMcpServers` /
 * `enabledMcpjsonServers` / `disabledMcpjsonServers` (approval of the
 * PROJECT's `.mcp.json`, which a profile chat loads as Global does),
 * `allowedMcpServers` (an allow-list policy), `claudeMdExcludes` (only filters
 * CLAUDE.md files), the managed-policy marketplace/plugin restrictions
 * (`strictKnownMarketplaces`, `blockedMarketplaces`, …) and the hook URL/env
 * policies (`allowedHttpHookUrls`, `httpHookAllowedEnvVars`).
 */
const CLAUDE_DROPPED_SETTINGS: Readonly<Record<string, string>> = {
  hooks: "user hooks are items; the profile brings its own",
  disableAllHooks: "a global kill switch would silence the profile's own hooks",
  enabledPlugins: "turns the user's installed plugins on or off",
  extraKnownMarketplaces: "plugin marketplaces (and their auto-installed plugins)",
  additionalMarketplaces: "alias of extraKnownMarketplaces",
  prependPlugins: "hook ordering of managed plugins",
  appendPlugins: "hook ordering of managed plugins",
  pluginConfigs: "per-plugin MCP user config of the user's plugins",
  pluginSuggestionMarketplaces: "plugin install suggestions",
  skillOverrides: "per-skill listing state of the user's skills",
  disableBundledSkills: "built-in skills are a profile setting",
  syncClaudeAiSkills: "claude.ai-synced skills (the recipe turns them off)",
  syncClaudeAiPlugins: "claude.ai-synced plugins (the recipe turns them off)",
  disableClaudeAiConnectors: "claude.ai connectors (the recipe turns them off)",
  allowAllClaudeAiMcps: "loads claude.ai connectors alongside managed servers",
  managedMcpServers: "adds MCP servers",
  autoMemoryEnabled: "memory (the recipe turns it off)",
  autoMemoryDirectory: "memory",
  autoDreamEnabled: "memory consolidation",
  claudeMd: "instructions",
  agent: "a main-thread agent is an item (custom agents are not loaded)"
};

const CLAUDE_DROPPED = new Set(Object.keys(CLAUDE_DROPPED_SETTINGS));

/**
 * The account's user `settings.json` as the SDK `settings` object for a
 * profile chat: {@link CLAUDE_DROPPED_SETTINGS} removed, and from
 * `deniedMcpServers` the `{serverName}` entries (that is how the Agent config
 * editor switches a global server off — it must not block a profile server of
 * the same name); `serverCommand`/`serverUrl` deny rules are policy and stay.
 */
export function claudeRuntimeSettings(settings: Readonly<Doc>): Doc {
  const out = without(settings, CLAUDE_DROPPED);
  if (Array.isArray(out.deniedMcpServers)) {
    const kept = out.deniedMcpServers.filter((entry) => !(isPlainObject(entry) && "serverName" in entry));
    if (kept.length > 0) {
      out.deniedMcpServers = kept;
    } else {
      delete out.deniedMcpServers;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Codex — `config.toml`
// ---------------------------------------------------------------------------

/**
 * Top-level `config.toml` keys a profile `CODEX_HOME` does not inherit. Kept:
 * `projects.*` (trust entries — a project's `.codex/config.toml` loads as in
 * Global), `model*`, `model_provider(s)`, `approval_policy`, `sandbox_*`,
 * `profiles` (filtered the same way), `notify`, `features` (the recipe
 * overrides some), `tools`, `tui`, `history`, `shell_environment_policy`,
 * `project_doc_*`, `otel`, …
 */
const CODEX_DROPPED_CONFIG: Readonly<Record<string, string>> = {
  mcp_servers: "MCP servers",
  plugins: "enabled plugins",
  marketplaces: "plugin marketplaces",
  skills: "`[[skills.config]]` toggles of the user's skills and `[skills.bundled]` (the recipe sets its own)",
  hooks: "inline hooks and `hooks.state` trust entries keyed by the global hooks.json path",
  apps: "ChatGPT apps/connectors (the recipe turns the feature off)",
  instructions: "instructions",
  developer_instructions: "instructions",
  model_instructions_file: "instructions",
  experimental_instructions_file: "instructions",
  sqlite_home: "would point the profile home at the account's state DBs (spec §6.2: never)"
};

const CODEX_DROPPED = new Set(Object.keys(CODEX_DROPPED_CONFIG));

function codexLayer(config: Readonly<Doc>): Doc {
  const out = without(config, CODEX_DROPPED);
  // `[agents]` holds runtime limits (`max_threads`, …) as values and custom
  // agent roles as sub-tables (`[agents.<role>]`): the roles are items.
  if (isPlainObject(out.agents)) {
    const agents: Doc = {};
    for (const [key, value] of Object.entries(out.agents)) {
      if (!isPlainObject(value)) {
        agents[key] = value;
      }
    }
    out.agents = agents;
  }
  return out;
}

/** The global Codex `config.toml` (parsed) minus {@link CODEX_DROPPED_CONFIG}, `[agents.<role>]` tables, and the same inside every `[profiles.<name>]`. */
export function codexRuntimeConfig(config: Readonly<Doc>): Doc {
  const out = codexLayer(config);
  if (isPlainObject(out.profiles)) {
    const profiles: Doc = {};
    for (const [name, profile] of Object.entries(out.profiles)) {
      profiles[name] = isPlainObject(profile) ? codexLayer(profile) : profile;
    }
    out.profiles = profiles;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Grok — `config.toml`
// ---------------------------------------------------------------------------

/**
 * Top-level Grok `config.toml` keys a profile `GROK_HOME` does not inherit.
 * Kept: `cli` (the recipe overrides `auto_update`/`use_leader`), `ui`, models,
 * permissions, and `marketplace` (its `sources` and the
 * `official_marketplace_auto_installed` flag stop Grok re-installing the
 * official marketplace into the profile home; what it discovers is disabled
 * by name through `[plugins] disabled`).
 */
const GROK_DROPPED_CONFIG: Readonly<Record<string, string>> = {
  mcp_servers: "MCP servers",
  disabled_mcp_servers: "on/off state of the user's inherited MCP servers",
  plugins: "plugin on/off lists (the recipe writes `[plugins] disabled`)",
  skills: "skill paths/toggles (the recipe writes `[skills] ignore`)",
  hooks: "hooks",
  compat: "Claude/Cursor compatibility cells (the recipe writes every one)"
};

const GROK_DROPPED = new Set(Object.keys(GROK_DROPPED_CONFIG));

export function grokRuntimeConfig(config: Readonly<Doc>): Doc {
  return without(config, GROK_DROPPED);
}

// ---------------------------------------------------------------------------
// OpenCode — `opencode.json(c)`
// ---------------------------------------------------------------------------

/**
 * Top-level OpenCode config keys a profile server does not inherit. Kept:
 * `$schema`, `provider`, `model`, `small_model`, `enabled_providers` /
 * `disabled_providers`, `permission`, `tools`, `share`, `autoupdate`, `lsp`,
 * `formatter`, `keybinds`, `theme`, `tui`, `experimental`, `enterprise`, …
 */
const OPENCODE_DROPPED_CONFIG: Readonly<Record<string, string>> = {
  mcp: "MCP servers",
  plugin: "plugins",
  instructions: "instruction files",
  command: "commands",
  agent: "agents",
  mode: "deprecated alias of `agent`",
  default_agent: "names an agent, which may be one of the user's (OpenCode refuses a missing default agent)",
  skills: "skill paths/URLs (the recipe sets `skills.paths` to the project's folders)",
  references: "reference sources added to the agent's context",
  reference: "alias of `references`"
};

const OPENCODE_DROPPED = new Set(Object.keys(OPENCODE_DROPPED_CONFIG));

export function opencodeRuntimeConfig(config: Readonly<Doc>): Doc {
  return without(config, OPENCODE_DROPPED);
}
