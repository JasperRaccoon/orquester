/**
 * Claude adapter — skill discovery (spec §4.6.2, §4.6.4, §4.6.8).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/Drivers/ClaudeSkills.ts`, translated from Effect
 * into plain TypeScript and with T3's `yaml` dependency replaced by a
 * line-scanner over the frontmatter keys this file actually reads (no new
 * dependency is allowed in this build).
 *
 * Claude Code loads skills from `<CLAUDE_CONFIG_DIR>/skills` (user scope) and
 * `<cwd>/.claude/skills` (project scope), one directory per skill with a
 * `SKILL.md` carrying YAML frontmatter. The user root wins on a name
 * collision, matching the CLI. `.agents/skills` is a Codex location and is
 * deliberately NOT scanned: verified against the CLI, a skill that lives only
 * there is answered with `Unknown command`.
 *
 * The Agent SDK's init handshake reports a skill as a bare command name with
 * no path, and the path is what a source badge, an enabled state and the
 * invocability flags need — which is why the snapshot scans disk instead.
 */

import { promises as fs } from "node:fs";
import * as nodePath from "node:path";

import type { Skill } from "@orquester/api/agent-chat";

export type ClaudeSkillScope = "user" | "project";

/** Bounded so a pathological skills dir cannot stall a `sendTurn` rescan. */
const MAX_SKILL_DIRS_PER_ROOT = 500;

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

type SkillFrontmatter =
  | { kind: "missing" }
  | { kind: "malformed" }
  | {
      kind: "parsed";
      description?: string;
      userInvocationOnly?: boolean;
      userInvocable?: boolean;
    };

/**
 * Claude Code accepts the YAML 1.1 boolean spellings (`yes`/`no`, `on`/`off`,
 * `1`/`0`). Verified against the CLI by T3: a skill carrying
 * `user-invocable: no` is absent from its published slash commands, so a
 * strict `=== false` would offer a command the CLI rejects.
 */
export function parseFrontmatterBoolean(value: string): boolean | undefined {
  switch (value.trim().toLowerCase()) {
    case "true":
    case "yes":
    case "on":
    case "y":
    case "1":
      return true;
    case "false":
    case "no":
    case "off":
    case "n":
    case "0":
      return false;
    default:
      return undefined;
  }
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Read the three frontmatter keys this adapter uses. Only top-level
 * `key: value` lines are considered — a nested block is skipped rather than
 * guessed at, and a frontmatter block whose opening fence never closes is
 * `missing`, exactly as an unparsable one is `malformed`.
 */
export function parseSkillFrontmatter(contents: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return { kind: "missing" };
  }

  const body = match[1] ?? "";
  let sawKey = false;
  let description: string | undefined;
  let userInvocationOnly: boolean | undefined;
  let userInvocable: boolean | undefined;

  for (const rawLine of body.split(/\r?\n/)) {
    if (rawLine.trim().length === 0 || rawLine.trimStart().startsWith("#")) {
      continue;
    }
    // Indented lines belong to a nested structure; this scanner reads only the
    // top level, so they are not keys.
    if (/^\s/.test(rawLine)) {
      continue;
    }
    const separator = rawLine.indexOf(":");
    if (separator < 0) {
      // A frontmatter body that is not a key/value map at all is malformed —
      // the CLI would not load the skill either.
      return { kind: "malformed" };
    }
    sawKey = true;
    const key = rawLine.slice(0, separator).trim();
    const value = unquote(rawLine.slice(separator + 1));
    if (key === "description") {
      description = value.trim().length > 0 ? value.trim() : undefined;
    } else if (key === "disable-model-invocation") {
      userInvocationOnly = parseFrontmatterBoolean(value);
    } else if (key === "user-invocable") {
      userInvocable = parseFrontmatterBoolean(value);
    }
  }

  if (!sawKey) {
    return { kind: "malformed" };
  }

  return {
    kind: "parsed",
    ...(description !== undefined ? { description } : {}),
    ...(userInvocationOnly === true ? { userInvocationOnly: true } : {}),
    ...(userInvocable === false ? { userInvocable: false } : {})
  };
}

/**
 * Where an administrator installs the policy file whose settings outrank every
 * user and project one. Absent on almost every machine, which is why a missing
 * file is the normal case rather than an error.
 */
export function claudeManagedSettingsPath(platform: NodeJS.Platform): string | undefined {
  if (platform === "darwin") {
    return "/Library/Application Support/ClaudeCode/managed-settings.json";
  }
  if (platform === "win32") {
    const programData = process.env.PROGRAMDATA?.trim();
    return programData ? nodePath.join(programData, "ClaudeCode", "managed-settings.json") : undefined;
  }
  return "/etc/claude-code/managed-settings.json";
}

/**
 * Settings files Claude Code merges for `skillOverrides`, in increasing
 * precedence: user, project, project-local, the repository root's local file
 * when the cwd sits deeper in a checkout, then the administrator's managed
 * policy, which wins outright.
 */
export function skillOverrideSettingsPaths(input: {
  configDir: string;
  cwd?: string;
  platform: NodeJS.Platform;
  repositoryRoot?: string;
}): string[] {
  const { configDir, cwd, platform, repositoryRoot } = input;
  const managed = claudeManagedSettingsPath(platform);
  const root =
    repositoryRoot !== undefined && repositoryRoot !== cwd ? repositoryRoot : undefined;
  return [
    nodePath.join(configDir, "settings.json"),
    ...(cwd
      ? [
          nodePath.join(cwd, ".claude", "settings.json"),
          nodePath.join(cwd, ".claude", "settings.local.json")
        ]
      : []),
    ...(root ? [nodePath.join(root, ".claude", "settings.local.json")] : []),
    ...(managed ? [managed] : [])
  ];
}

/**
 * The four states Claude Code accepts. The CLI validates the whole map, not
 * each entry: one entry with an unknown value makes it drop every override in
 * that file, so this does the same rather than applying the valid siblings the
 * CLI ignores.
 */
const SKILL_OVERRIDE_VALUES = new Set(["on", "name-only", "user-invocable-only", "off"]);

export interface SkillOverride {
  enabled: boolean;
  userInvocationOnly: boolean;
}

function parseSkillOverrideValue(value: string): SkillOverride {
  switch (value) {
    case "off":
      return { enabled: false, userInvocationOnly: false };
    case "user-invocable-only":
      return { enabled: true, userInvocationOnly: true };
    default:
      return { enabled: true, userInvocationOnly: false };
  }
}

/**
 * These settings files are hand-edited and Claude Code itself tolerates
 * comments and trailing commas in them, so the read is lenient in exactly
 * those two ways and strict about everything else.
 */
export function parseLenientJson(contents: string): unknown {
  const withoutComments = stripJsonComments(contents);
  const withoutTrailingCommas = withoutComments.replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(withoutTrailingCommas);
  } catch {
    return undefined;
  }
}

function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  let index = 0;
  while (index < input.length) {
    const ch = input[index]!;
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      index += 1;
      continue;
    }
    if (ch === "/" && input[index + 1] === "/") {
      const nl = input.indexOf("\n", index);
      index = nl === -1 ? input.length : nl;
      continue;
    }
    if (ch === "/" && input[index + 1] === "*") {
      const end = input.indexOf("*/", index + 2);
      index = end === -1 ? input.length : end + 2;
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}

export function readSkillOverridesFromSettings(
  contents: string
): ReadonlyMap<string, SkillOverride> | undefined {
  const parsed = parseLenientJson(contents);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const overrides = (parsed as { skillOverrides?: unknown }).skillOverrides;
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    return undefined;
  }
  const result = new Map<string, SkillOverride>();
  for (const [name, value] of Object.entries(overrides as Record<string, unknown>)) {
    if (typeof value !== "string" || !SKILL_OVERRIDE_VALUES.has(value)) {
      // One bad entry drops the whole file's overrides, as the CLI does.
      return undefined;
    }
    result.set(name, parseSkillOverrideValue(value));
  }
  return result;
}

async function readFileOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Nearest ancestor of `cwd` (inclusive) holding a `.git` entry, which is the
 * boundary Claude Code walks up to for project settings. `undefined` outside a
 * repository.
 */
export async function findRepositoryRoot(cwd: string): Promise<string | undefined> {
  let current = nodePath.resolve(cwd);
  for (;;) {
    try {
      await fs.stat(nodePath.join(current, ".git"));
      return current;
    } catch {
      // Not a repository root; keep walking.
    }
    const parent = nodePath.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

async function readSkillOverrides(input: {
  configDir: string;
  cwd?: string;
}): Promise<ReadonlyMap<string, SkillOverride>> {
  const repositoryRoot = input.cwd === undefined ? undefined : await findRepositoryRoot(input.cwd);
  const merged = new Map<string, SkillOverride>();
  const paths = skillOverrideSettingsPaths({
    configDir: input.configDir,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    platform: process.platform,
    ...(repositoryRoot !== undefined ? { repositoryRoot } : {})
  });
  for (const settingsPath of paths) {
    const contents = await readFileOrUndefined(settingsPath);
    if (contents === undefined) {
      continue;
    }
    const overrides = readSkillOverridesFromSettings(contents);
    if (!overrides) {
      continue;
    }
    for (const [name, override] of overrides) {
      merged.set(name, override);
    }
  }
  return merged;
}

export interface DiscoverClaudeSkillsInput {
  /** The absolute `CLAUDE_CONFIG_DIR` the spawned CLI will see. */
  configDir: string;
  cwd?: string;
}

/**
 * Enumerate Claude Code skills from the config dir and the workspace
 * `.claude/skills`. Discovery is best-effort: unreadable roots and malformed
 * skill entries are skipped so a broken skill never degrades the snapshot.
 * Roots are listed highest precedence first and the first hit for a name wins,
 * matching Claude Code. A skill's identity is its **directory name**, not the
 * frontmatter `name`: the CLI publishes `probe-alias/` as `probe-alias` even
 * when its frontmatter says otherwise, and only `skillOverrides["probe-alias"]`
 * switches it off.
 */
export async function discoverClaudeSkills(
  input: DiscoverClaudeSkillsInput
): Promise<Skill[]> {
  const overrides = await readSkillOverrides(input);

  const roots: Array<{ directory: string; scope: ClaudeSkillScope }> = [
    { directory: nodePath.join(input.configDir, "skills"), scope: "user" },
    ...(input.cwd
      ? [{ directory: nodePath.join(input.cwd, ".claude", "skills"), scope: "project" as const }]
      : [])
  ];

  const byName = new Map<string, Skill>();
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await fs.readdir(root.directory);
    } catch {
      continue;
    }

    for (const entry of [...entries].sort().slice(0, MAX_SKILL_DIRS_PER_ROOT)) {
      const name = entry.trim();
      if (name.length === 0 || byName.has(name)) {
        continue;
      }
      const skillPath = nodePath.join(root.directory, entry, "SKILL.md");
      const contents = await readFileOrUndefined(skillPath);
      if (contents === undefined) {
        continue;
      }
      const frontmatter = parseSkillFrontmatter(contents);
      // Malformed frontmatter means the skill will not load in Claude Code
      // either — skip it rather than surfacing a broken entry.
      if (frontmatter.kind === "malformed") {
        continue;
      }
      const override = overrides.get(name);
      const userInvocationOnly =
        (frontmatter.kind === "parsed" && frontmatter.userInvocationOnly === true) ||
        override?.userInvocationOnly === true;
      byName.set(name, {
        name,
        path: skillPath,
        enabled: override?.enabled ?? true,
        scope: root.scope,
        ...(frontmatter.kind === "parsed" && frontmatter.description !== undefined
          ? { description: frontmatter.description }
          : {}),
        ...(userInvocationOnly ? { userInvocationOnly: true } : {}),
        ...(frontmatter.kind === "parsed" && frontmatter.userInvocable === false
          ? { userInvocable: false }
          : {})
      });
    }
  }

  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The set handed to the dispatcher (§4.6.4): disabled and agent-reserved
 * skills are excluded, so a rewritten `/name` can never be one the CLI would
 * answer with a notice.
 */
export function dispatchableSkillNames(skills: readonly Skill[]): Set<string> {
  return new Set(
    skills.filter((skill) => skill.enabled && skill.userInvocable !== false).map((s) => s.name)
  );
}
