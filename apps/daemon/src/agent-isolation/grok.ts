/**
 * Agent isolation — Grok exclusion lists and the profile `config.toml`
 * (spec §6.3).
 *
 * Verified with Grok 1.0.46:
 * - `[skills] ignore` skips a listed directory's REAL entries but follows
 *   SYMLINKED ones, so every entry of `~/.claude/skills`, `~/.agents/skills`,
 *   `~/.claude/commands` and `~/.agents/commands` is listed by absolute path,
 *   and each symlinked entry's resolved target too ({@link grokSkillIgnoreList}).
 *   `compat.claude.skills` also loads `~/.claude/commands/*.md` as user skills;
 *   the repo's `.claude/commands` load as in a Global chat.
 * - Grok enables Claude-installed plugins on its own; `compat.claude.hooks =
 *   false` does not stop their hooks and `["*"]` does not work — only exact
 *   names in `[plugins] disabled` ({@link grokDiscoveredPluginNames}). Note
 *   `grok inspect` lists a disabled plugin as enabled; confirm with the debug
 *   log, not inspect.
 * - Every `[compat.claude.*]` / `[compat.cursor.*]` cell is off except
 *   `compat.claude.skills`: with it off the REPO's `.claude/skills` is lost too
 *   (and `[skills] paths` cannot bring it back), so it stays on and the user
 *   path is ignored instead. The same cells are also forced off by env
 *   ({@link GROK_PROFILE_ENV}) — never `GROK_CLAUDE_SKILLS_ENABLED`.
 * - Grok rewrites its `config.toml` itself: render it at every spawn.
 */

import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "@decimalturn/toml-patch";
import { withDeadline } from "../agent-host/support/deadline.ts";
import { describeExit, spawnProviderChild } from "../agent-host/support/spawn.ts";
import { grokRuntimeConfig } from "./runtime-settings.ts";

type Doc = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

/**
 * Env for a profile Grok process: Claude and Cursor rules, agents, MCP servers
 * and hooks off, Cursor skills off. Claude skills compat stays on (see the
 * module header).
 */
export const GROK_PROFILE_ENV: Readonly<Record<string, string>> = Object.freeze({
  GROK_CLAUDE_RULES_ENABLED: "false",
  GROK_CLAUDE_AGENTS_ENABLED: "false",
  GROK_CLAUDE_MCPS_ENABLED: "false",
  GROK_CLAUDE_HOOKS_ENABLED: "false",
  GROK_CURSOR_RULES_ENABLED: "false",
  GROK_CURSOR_AGENTS_ENABLED: "false",
  GROK_CURSOR_MCPS_ENABLED: "false",
  GROK_CURSOR_HOOKS_ENABLED: "false",
  GROK_CURSOR_SKILLS_ENABLED: "false"
});

/**
 * The variable naming the `auth.json` Grok reads (and refreshes in place, under
 * `<dir>/auth.json.lock`) instead of `<GROK_HOME>/auth.json`: a profile home
 * holds no credential, the account's file is used where it is.
 */
export const GROK_AUTH_PATH_ENV = "GROK_AUTH_PATH";

// ---------------------------------------------------------------------------
// [skills] ignore
// ---------------------------------------------------------------------------

/** The user-level skill and command roots, as Grok's own `~` spelling. */
export const GROK_USER_SKILL_ROOTS = ["~/.claude/skills", "~/.agents/skills", "~/.agents/commands", "~/.claude/commands"] as const;

/** The directories whose entries are listed one by one (relative to HOME). */
const LISTED_ROOTS = [
  [".claude", "skills"],
  [".agents", "skills"],
  [".claude", "commands"],
  [".agents", "commands"]
] as const;

/**
 * The `[skills] ignore` list for a profile Grok: {@link GROK_USER_SKILL_ROOTS},
 * then for each of `<home>/.claude/skills`, `<home>/.agents/skills`,
 * `<home>/.claude/commands` and `<home>/.agents/commands` every entry by
 * absolute path and, for a symlinked entry, its realpath as well (a dangling
 * link contributes only its own path); a root that is itself a symlink adds
 * its realpath too. Plus `<grokHome>/bundled/skills` when `hideBundled`.
 * Missing directories are skipped; the result has no duplicates. Compute it at
 * every spawn — a skill linked in later must be listed.
 */
export async function grokSkillIgnoreList(options: {
  home: string;
  grokHome: string;
  hideBundled: boolean;
}): Promise<string[]> {
  const out = new Set<string>(GROK_USER_SKILL_ROOTS);
  for (const segments of LISTED_ROOTS) {
    const root = join(options.home, ...segments);
    if (await isSymlink(root)) {
      const resolved = await realpathOrNull(root);
      if (resolved !== null) out.add(resolved);
    }
    let names: string[];
    try {
      names = (await readdir(root)).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const entry = join(root, name);
      out.add(entry);
      if (await isSymlink(entry)) {
        const resolved = await realpathOrNull(entry);
        if (resolved !== null) out.add(resolved);
      }
    }
  }
  if (options.hideBundled) {
    out.add(join(options.grokHome, "bundled", "skills"));
  }
  return [...out];
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// [plugins] disabled — `grok inspect --json`
// ---------------------------------------------------------------------------

export type GrokPluginNamesResult = { ok: true; names: string[] } | { ok: false; error: string };

const DEFAULT_INSPECT_TIMEOUT_MS = 30_000;
const INSPECT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Runs `grok inspect --json` (with `env` — `GROK_HOME` set to the profile home
 * — and `cwd`) and answers the exact `.plugins[].name` values, in report
 * order, without duplicates. Never throws: a spawn failure, a non-zero exit,
 * a deadline or an unreadable report is `{ ok: false, error }`.
 */
export async function grokDiscoveredPluginNames(options: {
  grokBin: string;
  env: Readonly<Record<string, string>>;
  cwd: string;
  timeoutMs?: number;
  /** Arguments to `grokBin`; `["inspect", "--json"]` unless a test runs a fake. */
  args?: readonly string[];
}): Promise<GrokPluginNamesResult> {
  let child;
  try {
    child = spawnProviderChild({
      command: options.grokBin,
      args: options.args ?? ["inspect", "--json"],
      env: { ...options.env },
      cwd: options.cwd
    });
  } catch (error) {
    return { ok: false, error: `grok inspect could not start: ${error instanceof Error ? error.message : String(error)}` };
  }
  child.stdin.end();
  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    if (stdoutBytes < INSPECT_MAX_BYTES) stdout.push(chunk);
    stdoutBytes += chunk.length;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-2048);
  });
  const timeoutMs = options.timeoutMs ?? DEFAULT_INSPECT_TIMEOUT_MS;
  let reason;
  try {
    reason = await withDeadline(child.exited, {
      label: "grok inspect --json",
      timeoutMs,
      onTimeout: () => {
        void child.kill();
      }
    });
  } catch (error) {
    await child.kill();
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const tail = stderr.trim().split("\n").slice(-3).join("\n");
  if (reason.kind !== "exit" || reason.code !== 0) {
    return { ok: false, error: `grok inspect --json ${describeExit(reason)}${tail ? `: ${tail}` : ""}` };
  }
  if (stdoutBytes > INSPECT_MAX_BYTES) {
    return { ok: false, error: `grok inspect --json printed more than ${INSPECT_MAX_BYTES} bytes` };
  }
  return parsePluginNames(Buffer.concat(stdout).toString("utf8"));
}

/** `.plugins[].name` of an inspect report (exact strings; non-string names skipped). */
export function parsePluginNames(stdout: string): GrokPluginNamesResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, error: "grok inspect --json did not print JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "grok inspect --json did not print an object" };
  }
  const plugins = (parsed as Doc).plugins;
  if (plugins === undefined) {
    return { ok: true, names: [] };
  }
  if (!Array.isArray(plugins)) {
    return { ok: false, error: "grok inspect --json: `plugins` is not an array" };
  }
  const names = new Set<string>();
  for (const plugin of plugins) {
    const name = typeof plugin === "object" && plugin !== null ? (plugin as Doc).name : undefined;
    if (typeof name === "string" && name.length > 0) {
      names.add(name);
    }
  }
  return { ok: true, names: [...names] };
}

// ---------------------------------------------------------------------------
// config.toml
// ---------------------------------------------------------------------------

/** The compat cells the profile config writes (all off except `claude.skills`). */
const GROK_COMPAT_CELLS = ["skills", "rules", "agents", "mcps", "hooks"] as const;

export interface GrokProfileConfigInput {
  /** The global `config.toml`, parsed; filtered with `grokRuntimeConfig` here again. */
  carriedOver: Readonly<Doc>;
  /** `[mcp_servers.<name>]` tables, in Grok's own shape. */
  mcpServers: Readonly<Record<string, Readonly<Doc>>>;
  /** From {@link grokSkillIgnoreList}. */
  skillsIgnore: readonly string[];
  /** Exact names of every discovered plugin that is not the profile's. */
  pluginsDisabled: readonly string[];
}

/**
 * The profile config as an object: the carried-over runtime settings, then
 * `[cli] auto_update = false, use_leader = false` (other `cli` keys kept),
 * the compat cells, `[skills] ignore`, `[plugins] disabled` and
 * `[mcp_servers]` — the recipe's keys win.
 */
export function grokProfileConfig(input: GrokProfileConfigInput): Doc {
  const doc = grokRuntimeConfig(input.carriedOver);
  const cli = typeof doc.cli === "object" && doc.cli !== null && !Array.isArray(doc.cli) ? (doc.cli as Doc) : {};
  doc.cli = { ...cli, auto_update: false, use_leader: false };
  const claude: Doc = {};
  const cursor: Doc = {};
  for (const cell of GROK_COMPAT_CELLS) {
    claude[cell] = cell === "skills";
    cursor[cell] = false;
  }
  doc.compat = { claude, cursor };
  doc.skills = { ignore: [...input.skillsIgnore] };
  doc.plugins = { disabled: [...input.pluginsDisabled] };
  if (Object.keys(input.mcpServers).length > 0) {
    doc.mcp_servers = structuredClone(input.mcpServers);
  }
  return doc;
}

/** {@link grokProfileConfig} as TOML text (sub-tables as `[a.b]` sections, deeper ones inline). */
export function renderGrokProfileConfigToml(input: GrokProfileConfigInput): string {
  return stringify(grokProfileConfig(input), { inlineTableStart: 2 });
}
