/**
 * Config sync — what syncs, per agent CLI and per kind of root (spec §8.3).
 *
 * A {@link BoxSyncScope} names config roots: an agent's account home (`CLAUDE_CONFIG_DIR`,
 * `CODEX_HOME`, `GROK_HOME`, OpenCode's `~/.config/opencode`) and/or an Agent Profile prepared
 * version dir. Each root gets a {@link SyncRule}: the top-level entries that sync (an include list —
 * an entry a CLI adds in a later version stays out until it is listed here), names excluded inside
 * them, the codec of each file (`codecs.ts`), and whether box-made changes are collected for the
 * owner's approval (account homes) or simply overwritten (prepared dirs: published versions are
 * immutable on the host, and the CLIs rewrite parts of them at every start).
 *
 * Left out everywhere: transcripts (`projects/`, `sessions/` — `transcripts.ts` mirrors them),
 * history files, caches, logs, telemetry (`statsig/`), shell snapshots, `todos/`, `ide/`, state
 * DBs, lock files, `.git/`.
 *
 * **Hard deny list.** {@link isDeniedRelPath} / {@link isDeniedRealPath} refuse credential files
 * (`.credentials.json`, `auth.json`, profile `secrets.json`, `.netrc`, ssh keys, `.npmrc`, …),
 * anything named like a credential, token, secret, password or key, and credential stores
 * (`.ssh/`, `.gnupg/`, `.aws/`, `~/.config/gh`, …). Both directions check it, on the path as the
 * CLI sees it AND on its realpath, so a symlink with an innocent name cannot carry a credential
 * file into a box, and a box cannot get one written on the host.
 */

import { posix } from "node:path";

import { boxesDir, boxSecretsPath, keysDir, secretFilesDir, sessionProfileSourcesDir, workflowSecretsPath } from "@orquester/config";

import type { BoxAgentId } from "../contracts.ts";

export type SyncAgent = BoxAgentId | "opencode";
export type SyncRootKind = "account" | "prepared";

/**
 * - `raw` — bytes as they are.
 * - `mcp-json` / `mcp-toml` — a JSON(C) / TOML config whose MCP env and header values and
 *   credential-named keys are blanked in the box copy and restored from the host on approval.
 * - `claude-json` — Claude's `.claude.json`: only the MCP servers and per-project MCP/trust keys
 *   sync (the rest is the CLI's own state: onboarding, tips, costs, `oauthAccount`, `userID`).
 */
export type SyncCodecId = "raw" | "mcp-json" | "mcp-toml" | "claude-json";

export interface SyncRule {
  agent: SyncAgent;
  kind: SyncRootKind;
  /** Box-made changes become pending approvals (true) or are overwritten by the host copy (false). */
  twoWay: boolean;
  /** Top-level entries (files or dirs) of the root that sync. */
  include: ReadonlySet<string>;
  /** Whether `rel` (POSIX, relative to the root, inside an included entry) stays out. */
  excluded(rel: string): boolean;
  codec(rel: string): SyncCodecId;
  /**
   * Whether `rel` is host → box only in a two-way root: the CLI manages it (marketplace refreshes)
   * and rewrites it in the box on its own, so a box-made change there is neither collected nor
   * undone; only a host change is pushed.
   */
  hostOnly(rel: string): boolean;
}

/** Names left out inside every included tree. */
const EXCLUDED_NAMES = new Set([
  ".git",
  ".DS_Store",
  "Thumbs.db",
  "__pycache__",
  ".cache",
  "cache.db",
  "logs",
  "log",
  "tmp",
  ".tmp"
]);

const EXCLUDED_SUFFIXES = [".lock", ".log", ".tmp", ".swp", ".sqlite", ".sqlite-wal", ".sqlite-shm", ".db-wal", ".db-shm", ".pyc"];

/** Our own temp files (`*.orq-sync-<id>`), never synced in either direction. */
export const SYNC_TEMP_MARKER = ".orq-sync-";

/** `orq-agent`'s temp files (`.<name>.orq-tmp-<n>` while a file channel writes), never synced either. */
export const BOX_AGENT_TEMP_MARKER = ".orq-tmp";

/** Whether a name is one of the two temp-file kinds. */
export function isTempName(name: string): boolean {
  return name.includes(SYNC_TEMP_MARKER) || name.includes(BOX_AGENT_TEMP_MARKER);
}

/**
 * Whether a name a box listed (or a session id it reported) can be one path segment: not empty,
 * not `.`/`..`, no separator of either OS, no NUL. A box's listing is untrusted input; every name
 * that becomes part of a host path goes through this.
 */
export function isSafeEntryName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !/[/\\\u0000]/.test(name);
}

/** Whether a POSIX relative path is made only of {@link isSafeEntryName} segments. */
export function isSafeRelPath(rel: string): boolean {
  return rel.length > 0 && rel.split("/").every(isSafeEntryName);
}

/**
 * Backups (`settings.json.bak-20260820`), CLI caches (`plugin-catalog-cache.json`,
 * `plugin-directory-cache-v2.json`), sweep markers (`.last_inuse_sweep`).
 */
const EXCLUDED_BASENAME = /\.bak(-[^/]*)?$|\.orig$|(^|[-_.])cache([-_.]v?\d+)?\.json$|^\.last[-_]/i;

function excludedByName(rel: string): boolean {
  for (const segment of rel.split("/")) {
    if (EXCLUDED_NAMES.has(segment)) return true;
    if (isTempName(segment)) return true;
  }
  const base = posix.basename(rel);
  return EXCLUDED_BASENAME.test(base) || EXCLUDED_SUFFIXES.some((suffix) => base.endsWith(suffix));
}

function rule(
  agent: SyncAgent,
  kind: SyncRootKind,
  include: readonly string[],
  options: { exclude?: (rel: string) => boolean; codecs?: Readonly<Record<string, SyncCodecId>>; hostOnly?: (rel: string) => boolean } = {}
): SyncRule {
  const codecs = options.codecs ?? {};
  return {
    agent,
    kind,
    twoWay: kind === "account",
    include: new Set(include),
    excluded: (rel) => excludedByName(rel) || (options.exclude?.(rel) ?? false),
    codec: (rel) => codecs[rel] ?? "raw",
    hostOnly: (rel) => options.hostOnly?.(rel) ?? false
  };
}

const startsWithDir = (rel: string, dir: string): boolean => rel === dir || rel.startsWith(`${dir}/`);

/** The Claude CLI's account-synced areas (`synced`, `.trash`, `.staging` in its skill and plugin stores). */
const CLAUDE_CLI_MANAGED = ["skills", "plugins"].flatMap((store) => ["synced", ".trash", ".staging"].map((dir) => `${store}/${dir}`));

/**
 * Claude `CLAUDE_CONFIG_DIR` (`syncAccountHome` links `skills`, `plugins`, `settings.json`,
 * `CLAUDE.md` and `commands` into the system `~/.claude`). `plugins/` holds the installed plugin
 * cache, `installed_plugins.json` and `known_marketplaces.json`; marketplace clones come without
 * `.git`.
 */
const CLAUDE_ACCOUNT = rule(
  "claude",
  "account",
  [
    ".claude.json",
    "settings.json",
    "settings.local.json",
    "CLAUDE.md",
    "skills",
    "commands",
    "agents",
    "plugins",
    "hooks",
    "output-styles",
    "keybindings.json"
  ],
  {
    // `plugins/data/` is the plugins' own runtime state (`${CLAUDE_PLUGIN_DATA}`), written as they run;
    // `plugins/store/` is the CLI's per-machine state for its built-in plugins (a panel left open).
    // `synced/`, `.trash/` and `.staging/` under `skills/` and `plugins/` are the CLI's own copy of
    // what the claude.ai account syncs (each box's CLI fetches it for the same account itself).
    // `plugins/cache/temp_git_*` are the CLI's leftover temporary clones; `.in_use/<pid>` in a
    // cached plugin are per-process markers of the machine they were made on, and `.orphaned_at`
    // is when that machine's CLI saw the version replaced.
    exclude: (rel) =>
      startsWithDir(rel, "plugins/data") ||
      startsWithDir(rel, "plugins/store") ||
      CLAUDE_CLI_MANAGED.some((dir) => startsWithDir(rel, dir)) ||
      /^plugins\/cache\/temp_git_[^/]*(\/|$)/.test(rel) ||
      (rel.startsWith("plugins/cache/") && rel.split("/").some((segment) => segment === ".in_use" || segment === ".orphaned_at")),
    codecs: { ".claude.json": "claude-json", "settings.json": "mcp-json", "settings.local.json": "mcp-json" },
    // Marketplaces are the CLI's own: a box CLI refreshes them on start (from a snapshot instead
    // of the host's git clone, say). The box gets the host's; what its CLI makes of them stays there.
    hostOnly: (rel) => rel === "plugins/known_marketplaces.json" || startsWithDir(rel, "plugins/marketplaces")
  }
);

/**
 * Claude prepared dir (`session-profiles/preparers/claude.ts`): what the CLI's launch options point
 * at. Its `manifest.json` is read by the agent host, on the host, so it stays out (as in every
 * prepared dir).
 */
const CLAUDE_PREPARED = rule("claude", "prepared", ["plugin", "plugins", "plugin-data", "mcp-servers.json", "instructions.md"], {
  codecs: { "mcp-servers.json": "mcp-json" }
});

/**
 * Codex `CODEX_HOME`. Not `sessions/` (transcripts), `archived_sessions/`, `history.jsonl`, the
 * state/log SQLite DBs, `version.json`, `models_cache.json`, `shell_snapshots/`. `skills/.system`
 * is Codex's bundled set, rewritten at every start.
 */
const CODEX_ACCOUNT = rule(
  "codex",
  "account",
  ["config.toml", "hooks.json", "AGENTS.md", "AGENTS.override.md", "prompts", "skills", "rules", "plugins", ".personality_migration", ".sandbox_migration"],
  {
    exclude: (rel) => startsWithDir(rel, "skills/.system"),
    codecs: { "config.toml": "mcp-toml" },
    // `plugins/` is Codex's own marketplace store: each box's Codex downloads the plugins
    // `config.toml` enables into `plugins/cache` itself. What turns one on is `config.toml`.
    hostOnly: (rel) => startsWithDir(rel, "plugins")
  }
);

/** Codex prepared `CODEX_HOME` (`preparers/codex.ts`); its `auth.json` and `sessions` are links to the account's. */
const CODEX_PREPARED = rule("codex", "prepared", ["config.toml", "hooks.json", "AGENTS.md", "skills", "plugins"], {
  exclude: (rel) => startsWithDir(rel, "skills/.system"),
  codecs: { "config.toml": "mcp-toml" }
});

/**
 * Grok `GROK_HOME` (`syncAccountHome`: shared `config.toml`, `trusted_folders.toml`, `hooks`,
 * `plugins`, `skills`, …; `installed-plugins/` holds the account's marketplace installs). Not
 * `sessions/`, `bundled/` (Grok's own, unpacked at start), `bin/`, `vendor/`, `marketplace-cache/`,
 * `worktrees.db`, `active_sessions.json`, `*.lock`.
 */
const GROK_ACCOUNT = rule(
  "grok",
  "account",
  ["config.toml", "trusted_folders.toml", "hooks", "plugins", "installed-plugins", "skills", "AGENTS.md", "commands", "rules"],
  { codecs: { "config.toml": "mcp-toml" } }
);

/** Grok prepared `GROK_HOME` (`preparers/grok.ts`). */
const GROK_PREPARED = rule(
  "grok",
  "prepared",
  ["AGENTS.md", "skills", "commands", "hooks", "profile", "config.toml", "trusted_folders.toml"],
  { codecs: { "config.toml": "mcp-toml", "profile/config.base.toml": "mcp-toml" } }
);

/** What OpenCode writes into a config dir itself (dependency installs for plugins). */
const OPENCODE_OWN = new Set(["node_modules", "package.json", "package-lock.json", "bun.lock", "bun.lockb", ".gitignore"]);

const OPENCODE_CONFIG_FILES = ["opencode.json", "opencode.jsonc", "config.json"];

/** OpenCode's `~/.config/opencode` (`agent-isolation/opencode-home.ts` lists what it loads). */
const OPENCODE_ACCOUNT = rule(
  "opencode",
  "account",
  [
    ...OPENCODE_CONFIG_FILES,
    "AGENTS.md",
    "agent",
    "agents",
    "command",
    "commands",
    "mode",
    "modes",
    "plugin",
    "plugins",
    "skill",
    "skills",
    "tool",
    "tools",
    "themes"
  ],
  {
    exclude: (rel) => rel.split("/").some((segment) => OPENCODE_OWN.has(segment)),
    codecs: Object.fromEntries(OPENCODE_CONFIG_FILES.map((name) => [name, "mcp-json" as const]))
  }
);

/**
 * OpenCode prepared version (`preparers/opencode.ts`): `opencode/` (its `OPENCODE_CONFIG_DIR`),
 * `home/` (`OPENCODE_TEST_HOME`, empty) and `xdg/` — created empty in the box: its entries are links
 * into the host's real `~/.config` (gh, git, …), which never sync.
 */
const OPENCODE_PREPARED = rule("opencode", "prepared", ["opencode", "home", "xdg"], {
  exclude: (rel) => rel.startsWith("xdg/") || rel.split("/").some((segment) => OPENCODE_OWN.has(segment)),
  codecs: Object.fromEntries(OPENCODE_CONFIG_FILES.map((name) => [`opencode/${name}`, "mcp-json" as const]))
});

const RULES: Readonly<Record<SyncAgent, Readonly<Record<SyncRootKind, SyncRule>>>> = {
  claude: { account: CLAUDE_ACCOUNT, prepared: CLAUDE_PREPARED },
  codex: { account: CODEX_ACCOUNT, prepared: CODEX_PREPARED },
  grok: { account: GROK_ACCOUNT, prepared: GROK_PREPARED },
  opencode: { account: OPENCODE_ACCOUNT, prepared: OPENCODE_PREPARED }
};

export function syncRuleFor(agent: SyncAgent, kind: SyncRootKind): SyncRule {
  return RULES[agent][kind];
}

/** `rule` with `top` its only included entry (a linked root: the one shared dir an account root links to). */
export function ruleWithOnly(rule: SyncRule, top: string): SyncRule {
  return { ...rule, include: new Set([top]) };
}

/** `rule` that also leaves out what `exclude` says. */
export function ruleExcluding(rule: SyncRule, exclude: (rel: string) => boolean): SyncRule {
  return { ...rule, excluded: (rel) => rule.excluded(rel) || exclude(rel) };
}

// ---------------------------------------------------------------------------
// Claude's plugin cache: installed versions only
// ---------------------------------------------------------------------------

/** Where a Claude config root lists its installed plugins (and the cache dir each one runs from). */
export const CLAUDE_INSTALLED_PLUGINS_REL = "plugins/installed_plugins.json";
const PLUGIN_CACHE_PREFIX = "plugins/cache/";

/**
 * The `plugins/cache` dirs (`<marketplace>/<plugin>/<version>`, relative to `plugins/cache`) a
 * Claude `installed_plugins.json` points at: each install's `installPath` below a
 * `/plugins/cache/` (of whichever account home wrote it; the box has the same paths), and its
 * `<name>@<marketplace>` + `version`. Null when the file does not parse as one.
 */
export function installedPluginCacheDirs(data: Buffer | string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString());
  } catch {
    return null;
  }
  const plugins = typeof parsed === "object" && parsed !== null ? (parsed as { plugins?: unknown }).plugins : undefined;
  if (typeof plugins !== "object" || plugins === null || Array.isArray(plugins)) return null;
  const out = new Set<string>();
  for (const [id, installs] of Object.entries(plugins as Record<string, unknown>)) {
    const at = id.lastIndexOf("@");
    const name = at > 0 ? id.slice(0, at) : null;
    const marketplace = at > 0 ? id.slice(at + 1) : null;
    // Version 1 files hold one install object per plugin, version 2 a list.
    for (const install of Array.isArray(installs) ? installs : [installs]) {
      if (typeof install !== "object" || install === null) continue;
      const { installPath, version } = install as { installPath?: unknown; version?: unknown };
      if (typeof installPath === "string") {
        const normalized = installPath.replace(/\\/g, "/");
        const index = normalized.lastIndexOf(`/${PLUGIN_CACHE_PREFIX}`);
        if (index >= 0) {
          const rel = normalized.slice(index + PLUGIN_CACHE_PREFIX.length + 1).replace(/\/+$/, "");
          if (isSafeRelPath(rel)) out.add(rel);
        }
      }
      if (name !== null && marketplace !== null && typeof version === "string") {
        const rel = `${marketplace}/${name}/${version}`;
        if (isSafeRelPath(rel)) out.add(rel);
      }
    }
  }
  return [...out];
}

/**
 * Whether `rel` is in `plugins/cache` but in none of the `allowed` dirs (nor on the way to one):
 * the old versions the CLI leaves behind. `allowed` null = no filter (no `installed_plugins.json`
 * on the host to go by).
 */
export function isUninstalledPluginCache(rel: string, allowed: ReadonlySet<string> | null): boolean {
  if (allowed === null || !rel.startsWith(PLUGIN_CACHE_PREFIX)) return false;
  const rest = rel.slice(PLUGIN_CACHE_PREFIX.length).split("/");
  for (const dir of allowed) {
    const parts = dir.split("/");
    const shorter = Math.min(parts.length, rest.length);
    let match = true;
    for (let index = 0; index < shorter && match; index++) match = parts[index] === rest[index];
    if (match) return false;
  }
  return true;
}

/** Whether `path` is `root` or inside it (both absolute POSIX paths, already normalized). */
export function isInsidePath(path: string, root: string): boolean {
  if (path === root) return true;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix);
}

/** The kind of a config root: inside the Agent Profiles prepared root = `prepared`. */
export function syncRootKind(root: string, preparedRoot: string | null): SyncRootKind {
  return preparedRoot !== null && isInsidePath(posix.normalize(root), posix.normalize(preparedRoot)) ? "prepared" : "account";
}

/**
 * Whether `rel` (relative to a root of `rule`) syncs at all: under an included top-level entry,
 * not excluded, not denied.
 */
export function isSyncedRel(rule: SyncRule, rel: string): boolean {
  if (!isSafeRelPath(rel)) return false;
  const top = rel.split("/")[0]!;
  if (!rule.include.has(top)) return false;
  if (rule.excluded(rel)) return false;
  return !isDeniedRelPath(rel);
}

// ---------------------------------------------------------------------------
// The hard deny list
// ---------------------------------------------------------------------------

/** Exact file names that are credentials whatever their content. */
const DENIED_BASENAMES = new Set([
  ".credentials.json",
  "auth.json",
  "secrets.json",
  "box-secrets.json",
  ".netrc",
  "_netrc",
  ".git-credentials",
  ".npmrc",
  ".yarnrc.yml",
  ".pypirc",
  ".pgpass",
  ".htpasswd",
  "known_hosts",
  "authorized_keys"
]);

/** A name that says credential, token, secret, password or key (`.pem`, `id_ed25519`, `.env`, …). */
const DENIED_NAME =
  /credential|token|secret|passw(or)?d|passphrase|private[-_.]?key|api[-_.]?key|apikey|\.pem$|\.key$|\.p12$|\.pfx$|\.jks$|\.keystore$|\.kdbx$|^id_(rsa|dsa|ecdsa|ed25519)(_sk)?(\.pub)?$|^\.env(\..*)?$/i;

/** Directories that are credential stores. */
const DENIED_DIRS = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".password-store", ".gcloud", ".terraform.d"]);

/** `~/.config/<name>` dirs that hold logins (gh's `hosts.yml`, gcloud, 1Password, …). */
const DENIED_CONFIG_DIRS = new Set(["gh", "gcloud", "op", "hub", "doctl", "flyctl", "vercel", "netlify", "heroku", "configstore"]);

function deniedSegments(segments: readonly string[], checkNames: boolean): boolean {
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    if (DENIED_DIRS.has(segment)) return true;
    if (segment === ".config" && DENIED_CONFIG_DIRS.has(segments[index + 1] ?? "")) return true;
    if (checkNames && (DENIED_BASENAMES.has(segment) || DENIED_NAME.test(segment))) return true;
  }
  return false;
}

/**
 * The path as a CLI sees it, relative to its config root: every segment is checked (a dir named
 * `tokens/` denies its whole tree).
 */
export function isDeniedRelPath(rel: string): boolean {
  return deniedSegments(rel.split(/[\\/]/).filter((segment) => segment.length > 0), true);
}

/**
 * An absolute host path (a realpath reached through symlinks, or a write target): credential store
 * dirs anywhere on it, a credential-like file NAME, or anything inside `denyRoots` (the daemon's
 * keys, secret stores, box credentials, Agent Profile sources).
 */
export function isDeniedRealPath(path: string, denyRoots: readonly string[] = []): boolean {
  const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0);
  if (deniedSegments(segments, false)) return true;
  const base = segments[segments.length - 1] ?? "";
  if (DENIED_BASENAMES.has(base) || DENIED_NAME.test(base)) return true;
  return denyRoots.some((root) => isInsidePath(path, root));
}

/**
 * A transcript file's name (its directories are the CLI's own encoding of the project path, which
 * may legitimately say `secret-files`): only the file name, credential store dirs and `denyRoots`
 * are checked.
 */
export function isDeniedTranscriptPath(path: string, denyRoots: readonly string[]): boolean {
  return isDeniedRealPath(path, denyRoots);
}

/** The daemon's own secret places: never read nor written by any sync. */
export function defaultSyncDenyRoots(appdir: string): string[] {
  return [
    keysDir(appdir),
    boxesDir(appdir),
    boxSecretsPath(appdir),
    workflowSecretsPath(appdir),
    secretFilesDir(appdir),
    sessionProfileSourcesDir(appdir)
  ];
}

// ---------------------------------------------------------------------------
// Which changes run code (for the approval card)
// ---------------------------------------------------------------------------

const SCRIPT_EXTENSIONS = new Set([
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".py",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
  ".rb",
  ".pl",
  ".php",
  ".lua",
  ".ps1",
  ".psm1",
  ".bat",
  ".cmd",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".jar",
  ".wasm"
]);

/** Dirs whose every file is code a CLI runs or loads (hooks, OpenCode plugins and tools, Codex exec rules). */
const CODE_DIRS = new Set(["hooks", "plugin", "tool", "tools", "rules"]);

/**
 * A key path in a structured config: key names, `"*"` for any key, or a pattern a key must match.
 * `["projects", "*", "allowedTools"]` is every project's `allowedTools`.
 */
export type ConfigKeyPattern = readonly (string | RegExp)[];

/**
 * In every structured config: keys whose values start processes (hooks, status lines, MCP servers,
 * notify commands, credential helpers) or say where requests and their credentials go.
 */
const COMMON_EXECUTABLE_KEYS: readonly ConfigKeyPattern[] = [
  ["hooks"],
  ["statusLine"],
  ["mcpServers"],
  ["mcp_servers"],
  ["mcp"],
  ["notify"],
  ["apiKeyHelper"],
  ["otelHeadersHelper"],
  [/base_?url$/i]
];

/**
 * Claude `settings.json`: `env` reaches the CLI and everything it runs (`NODE_OPTIONS`,
 * `*_BASE_URL`, `PATH`, proxies…), so any change there counts; permission mode and allow rules
 * let tools run unasked; plugins and marketplaces install code; AWS helpers and the file
 * suggestion command are commands.
 */
const CLAUDE_SETTINGS_KEYS: readonly ConfigKeyPattern[] = [
  ["env"],
  ["permissions", "defaultMode"],
  ["permissions", "allow"],
  ["enabledPlugins"],
  ["extraKnownMarketplaces"],
  ["enableAllProjectMcpServers"],
  ["enabledMcpjsonServers"],
  ["disabledMcpjsonServers"],
  ["awsAuthRefresh"],
  ["awsCredentialExport"],
  ["fileSuggestion"]
];

/** `.claude.json` (its synced subset): MCP servers, `.mcp.json` approvals, trust and allowed tools per project. */
const CLAUDE_JSON_KEYS: readonly ConfigKeyPattern[] = [
  ["mcpServers"],
  ...["mcpServers", "enabledMcpjsonServers", "disabledMcpjsonServers", "hasTrustDialogAccepted", "allowedTools"].map((key) => ["projects", "*", key])
];

/** Codex `config.toml`: providers and their endpoints, the shell's environment, approval and sandbox modes, trust. */
const CODEX_CONFIG_KEYS: readonly ConfigKeyPattern[] = [
  ["model_providers"],
  ["model_provider"],
  ["profiles"],
  ["profile"],
  ["shell_environment_policy"],
  ["approval_policy"],
  ["sandbox_mode"],
  ["sandbox_workspace_write"],
  ["projects", "*", "trust_level"]
];

/** Grok `config.toml`: model providers, feature switches (`support_permission`), permissions, plugins. */
const GROK_CONFIG_KEYS: readonly ConfigKeyPattern[] = [["models"], ["providers"], ["features"], ["permission"], ["permissions"], ["plugins"]];

/** OpenCode config: plugins, providers, formatters and LSP servers (commands), permissions (also per agent / mode). */
const OPENCODE_CONFIG_KEYS: readonly ConfigKeyPattern[] = [["plugin"], ["provider"], ["formatter"], ["lsp"], ["permission"], ["agent"], ["mode"], ["tools"]];

const EXECUTABLE_KEYS_BY_FILE: Readonly<Record<SyncAgent, Readonly<Record<string, readonly ConfigKeyPattern[]>>>> = {
  claude: { "settings.json": CLAUDE_SETTINGS_KEYS, "settings.local.json": CLAUDE_SETTINGS_KEYS, ".claude.json": CLAUDE_JSON_KEYS },
  codex: { "config.toml": CODEX_CONFIG_KEYS },
  grok: { "config.toml": GROK_CONFIG_KEYS, "profile/config.base.toml": GROK_CONFIG_KEYS },
  opencode: Object.fromEntries(OPENCODE_CONFIG_FILES.flatMap((name) => [[name, OPENCODE_CONFIG_KEYS], [`opencode/${name}`, OPENCODE_CONFIG_KEYS]]))
};

/** The key paths of a config file (`rel` in a root of `agent`) whose change runs code or redirects credentials. */
export function executableConfigKeys(agent: SyncAgent, rel: string): ConfigKeyPattern[] {
  return [...COMMON_EXECUTABLE_KEYS, ...(EXECUTABLE_KEYS_BY_FILE[agent][rel] ?? [])];
}

/**
 * Whether a changed file is executable for the card: a script under `plugins/`/`skills/` (by
 * extension or shebang), anything under a hooks/plugin/tool dir, a file with an exec bit, Grok's
 * folder trust list, or a config whose {@link executableConfigKeys} differ (`configKeysChanged`,
 * decided by the codec).
 */
export function isExecutableChange(input: {
  rule: SyncRule;
  rel: string;
  mode: number | null;
  content: Buffer | null;
  configKeysChanged: boolean;
}): boolean {
  if (input.configKeysChanged) return true;
  if (input.mode !== null && (input.mode & 0o111) !== 0) return true;
  const segments = input.rel.split("/");
  const top = segments[0]!;
  if (CODE_DIRS.has(top) || (input.rule.agent === "opencode" && top === "plugins")) return true;
  if (input.rule.kind === "prepared" && segments.includes("hooks")) return true;
  if (top === "hooks.json" || top === "trusted_folders.toml") return true;
  if (segments.some((segment) => segment === "hooks" || segment === "bin" || segment === "scripts")) return true;
  if (top === "plugins" || top === "skills" || top === "plugin" || top === "skill" || top === "profile") {
    const extension = posix.extname(input.rel).toLowerCase();
    if (SCRIPT_EXTENSIONS.has(extension)) return true;
    if (input.content !== null && input.content.subarray(0, 2).toString("latin1") === "#!") return true;
  }
  return false;
}
