/**
 * What OpenCode 1.18 refuses, checked before anything is written.
 *
 * Commands: a `commands/*.md` whose frontmatter does not decode against
 * `{template, description?, agent?, model?, variant?, subtask?}` THROWS while
 * OpenCode loads its config — every session loses the whole config — so the
 * known keys are type-checked strictly (a YAML `null` counts as wrong), and a
 * draft may only set those keys. Keys already on disk that OpenCode ignores
 * are left alone.
 *
 * Plugins: a `plugin[]` spec is an npm package spec, or a file the daemon
 * user owns (an absolute path or a `file://` URL).
 */

import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { profileErrors } from "../../errors.ts";
import { assertInside } from "../../infra/index.ts";
import { isJsonObject } from "./jsonc.ts";

/** A command's settings besides its template (body), with their types. */
const COMMAND_FIELDS = {
  description: "string",
  agent: "string",
  model: "string",
  variant: "string",
  subtask: "boolean"
} as const;

type CommandField = keyof typeof COMMAND_FIELDS;

function isCommandField(key: string): key is CommandField {
  return Object.hasOwn(COMMAND_FIELDS, key);
}

/** `provider/model`, as OpenCode parses a command's model. */
const MODEL_PATTERN = /^[^/\s#]+\/[^\s#]+$/;

function checkField(key: CommandField, value: unknown, fromDraft: boolean): void {
  const type = COMMAND_FIELDS[key];
  if (typeof value !== type) {
    throw profileErrors.invalidItem(
      `The command's "${key}" must be a ${type === "string" ? "text value" : "true/false value"}${
        value === null ? " (it is empty)" : ""
      }: OpenCode stops loading its whole config over a command it cannot read.`
    );
  }
  if (fromDraft && key === "model" && !MODEL_PATTERN.test(value as string)) {
    throw profileErrors.invalidItem(`The command's model must be written as provider/model (e.g. "anthropic/claude-sonnet-4").`);
  }
}

/** A draft may set only OpenCode's command keys (`null` removes any key). */
export function checkCommandDraftFrontmatter(frontmatter: unknown): Record<string, unknown> {
  if (frontmatter === undefined) return {};
  if (!isJsonObject(frontmatter)) {
    throw profileErrors.invalidItem("The command's frontmatter must be a set of fields.");
  }
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === null || value === undefined) continue;
    if (!isCommandField(key)) {
      throw profileErrors.invalidItem(
        `OpenCode commands have no "${key}" setting; use ${Object.keys(COMMAND_FIELDS).join(", ")}.`
      );
    }
    checkField(key, value, true);
  }
  return frontmatter;
}

/** The frontmatter about to be written: every command key OpenCode reads has the right type. */
export function checkCommandFrontmatter(frontmatter: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(frontmatter)) {
    if (key === "template") {
      throw profileErrors.invalidItem(`A command file has no "template" setting: the body is the template.`);
    }
    if (isCommandField(key)) {
      checkField(key, value, false);
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin specs
// ---------------------------------------------------------------------------

/** An npm package name, then optionally `@<version, range or tag>`. */
const NPM_SPEC = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(@[^\s@]+)?$/;

/** How OpenCode treats a spec: a path (`file://`, `.`-relative or absolute) or an npm package. */
export function isPathSpec(spec: string): boolean {
  return spec.startsWith("file://") || spec.startsWith(".") || isAbsolute(spec);
}

/** The package a spec names (OpenCode keeps the last of a package listed twice); a path spec is its own key. */
export function pluginPackageKey(spec: string): string {
  if (isPathSpec(spec)) return spec;
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  return at > 0 ? spec.slice(0, at) : spec;
}

/** The version part of an npm spec (`pkg@1.2.3` → `1.2.3`). */
export function pluginSpecVersion(spec: string): string | undefined {
  if (isPathSpec(spec)) return undefined;
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  return at > 0 ? spec.slice(at + 1) : undefined;
}

/**
 * Checks a spec the owner typed. A path must exist and resolve inside the
 * daemon user's home (so a plugin cannot be pointed at another user's file);
 * a relative path is refused — it would resolve against the config folder.
 */
export async function checkPluginSpec(spec: unknown, home: string): Promise<string> {
  if (typeof spec !== "string" || spec.trim().length === 0) {
    throw profileErrors.invalidItem("Enter an npm package (name or name@version) or the absolute path of a plugin file.");
  }
  const value = spec.trim();
  if (!isPathSpec(value)) {
    if (value.length > 214 + 64 || !NPM_SPEC.test(value)) {
      throw profileErrors.invalidItem(`"${value}" is not an npm package spec (name or name@version).`);
    }
    return value;
  }
  if (value.startsWith(".")) {
    throw profileErrors.invalidItem("Use the plugin's absolute path, not a relative one.");
  }
  let path: string;
  try {
    path = value.startsWith("file://") ? fileURLToPath(value) : value;
  } catch {
    throw profileErrors.invalidItem(`"${value}" is not a valid file URL.`);
  }
  let kind: "file" | "dir" | null = null;
  try {
    const st = await stat(path);
    kind = st.isFile() ? "file" : st.isDirectory() ? "dir" : null;
  } catch {
    kind = null;
  }
  if (kind === null) {
    throw profileErrors.invalidItem(`${path} does not exist.`);
  }
  await assertInside(home, path);
  if (kind === "file" && !/\.(m?js|ts)$/.test(path)) {
    throw profileErrors.invalidItem("A plugin file must be a .js or .ts file.");
  }
  return value;
}
