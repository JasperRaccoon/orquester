/**
 * OpenCode's global config as OpenCode 1.18 loads it (`Config.getGlobal`):
 * `config.json`, then `opencode.json`, then `opencode.jsonc` from
 * `~/.config/opencode`, each decoded on its own (a `permission` string
 * becomes `{"*": <action>}`) and deep-merged in that order — objects merge key
 * by key, anything else (arrays included) is replaced by the later file.
 *
 * OpenCode itself writes to the first of `opencode.jsonc`, `opencode.json`,
 * `config.json` that exists (else creates `opencode.jsonc`), which is always
 * the LAST file loaded: an edit there wins over the others. This module picks
 * the same file.
 */

import { join } from "node:path";
import type { ProfileFileError } from "@orquester/api";
import { readTextIfExists } from "../../infra/index.ts";
import { type JsonObject, isJsonObject, parseJsoncObject } from "./jsonc.ts";

/** The global config files in OpenCode's load order. */
export const CONFIG_FILE_NAMES = ["config.json", "opencode.json", "opencode.jsonc"] as const;
export type ConfigFileName = (typeof CONFIG_FILE_NAMES)[number];

/** The file OpenCode writes to: the first of these that exists. */
const WRITE_PREFERENCE: readonly ConfigFileName[] = ["opencode.jsonc", "opencode.json", "config.json"];

export const OPENCODE_SCHEMA_URL = "https://opencode.ai/config.json";

/** What OpenCode writes into a config file it creates. */
export const NEW_CONFIG_TEXT = `${JSON.stringify({ $schema: OPENCODE_SCHEMA_URL }, null, 2)}`;

export interface ConfigFile {
  name: ConfigFileName;
  path: string;
  text: string;
  /** `null` when the file does not parse. */
  value: JsonObject | null;
  error?: string;
}

export interface ConfigState {
  /** The files that exist, in load order. */
  files: ConfigFile[];
  /** The file every edit goes to (it may not exist yet). */
  targetPath: string;
  targetName: ConfigFileName;
  /** The target's current text, or the text a new file starts from. */
  targetText: string;
  /** The target's parsed value (`{}` for a new file); `null` when it does not parse. */
  targetValue: JsonObject | null;
  targetExists: boolean;
  /** The config OpenCode ends up with; files that do not parse are left out. */
  merged: JsonObject;
  fileErrors: ProfileFileError[];
  /** Some file did not parse: what OpenCode loads cannot be known (it falls back to defaults). */
  broken: boolean;
}

/** OpenCode's per-file decode of the parts this adapter reads: a `permission` action string is `{"*": action}`. */
export function decodeConfigFile(value: JsonObject): JsonObject {
  if (typeof value.permission === "string") {
    return { ...value, permission: { "*": value.permission } };
  }
  return value;
}

/** remeda's `mergeDeep`, as OpenCode merges its config files: objects key by key, anything else replaced. */
export function mergeDeep(target: JsonObject, source: JsonObject): JsonObject {
  const out: JsonObject = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const existing = out[key];
    out[key] = isJsonObject(existing) && isJsonObject(value) ? mergeDeep(existing, value) : value;
  }
  return out;
}

/** Merges already-parsed file values in load order (each decoded first). */
export function mergeConfigValues(values: readonly JsonObject[]): JsonObject {
  let merged: JsonObject = {};
  for (const value of values) {
    merged = mergeDeep(merged, decodeConfigFile(value));
  }
  return merged;
}

export async function readConfigState(dir: string): Promise<ConfigState> {
  const files: ConfigFile[] = [];
  const fileErrors: ProfileFileError[] = [];
  for (const name of CONFIG_FILE_NAMES) {
    const path = join(dir, name);
    let text: string | null;
    try {
      text = await readTextIfExists(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fileErrors.push({ path, message });
      files.push({ name, path, text: "", value: null, error: message });
      continue;
    }
    if (text === null) {
      continue;
    }
    const parsed = parseJsoncObject(text);
    if (parsed.ok) {
      files.push({ name, path, text, value: parsed.value });
    } else {
      fileErrors.push({ path, message: parsed.error });
      files.push({ name, path, text, value: null, error: parsed.error });
    }
  }
  const existing = new Map(files.map((file) => [file.name, file]));
  const targetName = WRITE_PREFERENCE.find((name) => existing.has(name)) ?? "opencode.jsonc";
  const target = existing.get(targetName);
  const targetText = target === undefined || target.text.length === 0 ? NEW_CONFIG_TEXT : target.text;
  return {
    files,
    targetPath: join(dir, targetName),
    targetName,
    targetText,
    targetValue: target === undefined ? {} : target.value,
    targetExists: target !== undefined,
    merged: mergeConfigValues(files.flatMap((file) => (file.value === null ? [] : [file.value]))),
    fileErrors,
    broken: files.some((file) => file.value === null)
  };
}

/** The merged config if the target's text were `targetText` (the other files as they are). */
export function mergedWithTarget(state: ConfigState, targetText: string): JsonObject {
  const parsed = parseJsoncObject(targetText);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const values = state.files.flatMap((file) => {
    if (file.path === state.targetPath) return [];
    return file.value === null ? [] : [file.value];
  });
  // The target is always the last file loaded.
  return mergeConfigValues([...values, parsed.value]);
}

// ---------------------------------------------------------------------------
// Permissions (OpenCode's `Permission.fromConfig` / `evaluate` / `Wildcard.match`)
// ---------------------------------------------------------------------------

export type PermissionAction = "allow" | "ask" | "deny";

export function isPermissionAction(value: unknown): value is PermissionAction {
  return value === "allow" || value === "ask" || value === "deny";
}

interface PermissionRule {
  permission: string;
  pattern: string;
  action: string;
}

/** OpenCode's wildcard: `*` any run, `?` one character, a trailing ` *` also matches nothing. */
export function wildcardMatch(value: string, pattern: string): boolean {
  const subject = value.replaceAll("\\", "/");
  let source = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (source.endsWith(" .*")) {
    source = `${source.slice(0, -3)}( .*)?`;
  }
  return new RegExp(`^${source}$`, "s").test(subject);
}

function rulesFromConfig(permission: JsonObject): PermissionRule[] {
  const rules: PermissionRule[] = [];
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      rules.push({ permission: key, pattern: "*", action: value });
    } else if (isJsonObject(value)) {
      for (const [pattern, action] of Object.entries(value)) {
        if (typeof action === "string") {
          rules.push({ permission: key, pattern, action });
        }
      }
    }
  }
  return rules;
}

/** The legacy `tools: {name: bool}` map OpenCode folds in front of `permission`. */
function toolsPermission(tools: unknown): JsonObject {
  const out: JsonObject = {};
  if (!isJsonObject(tools)) return out;
  for (const [name, on] of Object.entries(tools)) {
    const action = on ? "allow" : "deny";
    if (name === "write" || name === "edit" || name === "patch") {
      out.edit = action;
    } else {
      out[name] = action;
    }
  }
  return out;
}

/**
 * What the global config decides for `permission` on `pattern` — the build
 * agent's view: OpenCode's defaults (`"*": "allow"`) then the config's rules,
 * the last matching rule winning. Agent-specific overrides are not included.
 */
export function evaluatePermission(merged: JsonObject, permission: string, pattern: string): string {
  let config: JsonObject = isJsonObject(merged.permission) ? merged.permission : {};
  if (isJsonObject(merged.tools)) {
    config = mergeDeep(toolsPermission(merged.tools), config);
  }
  const rules: PermissionRule[] = [{ permission: "*", pattern: "*", action: "allow" }, ...rulesFromConfig(config)];
  for (let i = rules.length - 1; i >= 0; i -= 1) {
    const rule = rules[i]!;
    if (wildcardMatch(permission, rule.permission) && wildcardMatch(pattern, rule.pattern)) {
      return rule.action;
    }
  }
  return "ask";
}

/** Whether OpenCode offers the skill `name` (anything but `deny`). */
export function skillAllowed(merged: JsonObject, name: string): boolean {
  return evaluatePermission(merged, "skill", name) !== "deny";
}
