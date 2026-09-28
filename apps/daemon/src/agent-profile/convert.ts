/**
 * Agent profile — converting a copyable item (`PROFILE_COPYABLE_KINDS`) from
 * one agent's shape to another's (spec §6, "Copy from / to another agent").
 *
 * - **skill** — all four agents use `<name>/SKILL.md`; the name is checked
 *   against the target's rule and the frontmatter keys are mapped to the
 *   target's fields (`PROFILE_FRONTMATTER_FIELDS[to].skill`: Claude
 *   `when_to_use` ↔ Grok `when-to-use`, keys matched with `_` ≡ `-`); a key the
 *   target does not use is dropped with a note, except `name`, `description`
 *   and `metadata`, which every skill keeps. `name` is forced to the item's.
 * - **command** — the name is checked (Grok's commands are flat: `git/pr`
 *   becomes `git-pr`); only the target's command fields survive (a command's
 *   frontmatter is validated strictly by some agents). **To Codex** a command
 *   becomes a skill: Codex has no custom commands (its `prompts/` are legacy).
 * - **mcp** — the transport must be one the target accepts
 *   (`MCP_TRANSPORTS`), the name must pass `isValidMcpServerName`; env and
 *   header values travel as they are (they are never put in a note, an error
 *   or a log); the `advanced` extras are mapped per `MCP_ADVANCED_FIELDS`.
 *
 * `from === to` is the identity: the same item, no notes.
 *
 * ## Temp directory ownership
 * A skill whose `SKILL.md` has to change (and a command that becomes a Codex
 * skill) is written into a NEW directory, `<tempRoot>/convert-<random>`: the
 * input item's `dir` belongs to its source (an agent home or an import) and is
 * never modified. The result then carries `tempDir` (equal to the returned
 * `item.dir`), and the CALLER removes it (`rm -rf`) once the item has been
 * imported, whether that succeeded or not. When `tempDir` is absent the
 * returned item is the input's own `dir` and there is nothing to remove.
 * A leaked `convert-*` directory under the imports dir is swept by
 * `ProfileImportStore` once it is older than the import TTL.
 *
 * The converter is synchronous (the `ProfileConverter` seam): a skill is a
 * handful of small files, copied with the sync fs API, never following a
 * symlink inside it (a symlink refuses the copy, `IMPORT_FAILED`).
 */

import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_PROFILE_AGENT_LABELS,
  type AgentProfileAgentId,
  MCP_ADVANCED_FIELDS,
  MCP_TRANSPORTS,
  PROFILE_FRONTMATTER_FIELDS
} from "@orquester/api";
import { profileErrors } from "./errors.ts";
import type { PortableItem, PortableMcpServer } from "./adapters/types.ts";
import {
  SKILL_FILE,
  assertCommandName,
  assertMcpServerName,
  assertSkillName,
  parseMarkdownDocument,
  serializeMarkdownDocument
} from "./infra/index.ts";

/** What a conversion answers. `tempDir`: see "Temp directory ownership" in the module header. */
export interface ProfileConversion {
  item: PortableItem;
  notes: string[];
  /** A directory the converter created (the returned skill's `dir`); the caller removes it. */
  tempDir?: string;
}

/** The seam the service calls: `(item, from, to) => {item, notes}` (plus `tempDir`, see above). */
export type ProfileConverter = (
  item: PortableItem,
  from: AgentProfileAgentId,
  to: AgentProfileAgentId
) => ProfileConversion;

export interface ProfileConverterOptions {
  /**
   * Where converted skill copies are written (`convert-*` directories). The
   * daemon passes `agentProfileImportsDir(appdir)`; defaults to the OS temp dir.
   */
  tempRoot: string;
}

/** The prefix of every directory the converter creates under its temp root. */
export const CONVERT_DIR_PREFIX = "convert-";

/** Frontmatter keys every skill keeps whatever the target's field list says. */
const SKILL_KEYS_ALWAYS_KEPT = new Set(["name", "description", "metadata"]);

const label = (agent: AgentProfileAgentId): string => AGENT_PROFILE_AGENT_LABELS[agent];

/** `when_to_use` and `when-to-use` are one key: case and `_`/`-` do not matter. */
function canonicalKey(key: string): string {
  return key.toLowerCase().replaceAll("_", "-");
}

export interface MappedFrontmatter {
  frontmatter: Record<string, unknown>;
  /** Keys left out because `to` does not use them, in their original spelling and order. */
  dropped: string[];
}

/**
 * `frontmatter` with its keys renamed to `to`'s spelling of the same field
 * (`PROFILE_FRONTMATTER_FIELDS[to][kind]`) and every key `to` does not use
 * dropped — skills keep `name`, `description` and `metadata` regardless. Key
 * order is kept; when two keys map to one field the first wins and the other
 * is dropped. Values are carried as they are.
 */
export function mapFrontmatter(
  frontmatter: Record<string, unknown>,
  kind: "skill" | "command",
  to: AgentProfileAgentId
): MappedFrontmatter {
  const fields = PROFILE_FRONTMATTER_FIELDS[to][kind] ?? [];
  const byCanonical = new Map(fields.map((field) => [canonicalKey(field.key), field.key]));
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined) continue;
    const target = kind === "skill" && SKILL_KEYS_ALWAYS_KEPT.has(key) ? key : byCanonical.get(canonicalKey(key));
    if (target === undefined || Object.hasOwn(out, target)) {
      dropped.push(key);
      continue;
    }
    out[target] = value;
  }
  return { frontmatter: out, dropped };
}

/** The owner-facing note for dropped frontmatter keys, or nothing. */
export function droppedKeysNote(dropped: readonly string[], to: AgentProfileAgentId): string[] {
  return dropped.length === 0 ? [] : [`Dropped frontmatter keys ${label(to)} does not use: ${dropped.join(", ")}.`];
}

/** Grok's commands are flat files: `git/pr` → `git-pr`. Other agents keep the one folder level. */
export function commandNameFor(name: string, to: AgentProfileAgentId): string {
  return to === "grok" ? name.replaceAll("/", "-") : name;
}

/** The skill a command becomes on Codex: `git/pr` → `git-pr`. */
export function commandSkillName(name: string): string {
  return name.replaceAll("/", "-");
}

/**
 * The `SKILL.md` document a command becomes on Codex: `{name, description}`
 * (the command's description, else "Converted from the /<name> command"),
 * plus any `metadata`; every other key is reported in `dropped`.
 */
export function commandToSkillDocument(
  name: string,
  frontmatter: Record<string, unknown>
): { skillName: string; frontmatter: Record<string, unknown>; dropped: string[] } {
  const skillName = commandSkillName(name);
  const description =
    typeof frontmatter.description === "string" && frontmatter.description.trim().length > 0
      ? frontmatter.description
      : `Converted from the /${name} command`;
  const dropped: string[] = [];
  const out: Record<string, unknown> = { name: skillName, description };
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined || key === "description" || key === "name") continue;
    if (key === "metadata") {
      out.metadata = value;
    } else {
      dropped.push(key);
    }
  }
  return { skillName, frontmatter: out, dropped };
}

export const CODEX_COMMAND_NOTE = "Codex has no custom commands; imported as a skill.";

// ---------------------------------------------------------------------------
// Sync file helpers
// ---------------------------------------------------------------------------

function makeTempDir(tempRoot: string): string {
  mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(tempRoot, CONVERT_DIR_PREFIX));
}

/**
 * Copies the directory `src` (followed when it is itself a symlink — the host
 * symlinks shared skills in) into the existing, empty directory `dest`,
 * never following a symlink inside it: one is refused (`IMPORT_FAILED`).
 */
function copyDirContentsSync(src: string, dest: string, rel = ""): void {
  for (const entry of readdirSync(src).sort()) {
    const from = join(src, entry);
    const to = join(dest, entry);
    const shown = rel === "" ? entry : `${rel}/${entry}`;
    const st = lstatSync(from);
    if (st.isSymbolicLink()) {
      throw profileErrors.importFailed(`"${shown}" is a symlink; symlinks are not imported.`);
    }
    if (st.isDirectory()) {
      mkdirSync(to, { mode: 0o700 });
      copyDirContentsSync(from, to, shown);
      chmodSync(to, st.mode & 0o777);
    } else if (st.isFile()) {
      copyFileSync(from, to, constants.COPYFILE_EXCL);
      chmodSync(to, st.mode & 0o777);
    }
    // Sockets, FIFOs and devices are not part of a skill.
  }
}

/** Writes `text` as the skill's `SKILL.md` into a new temp dir, after a copy of `srcDir` when given. */
function writeSkillCopy(tempRoot: string, text: string, srcDir?: string): string {
  const dir = makeTempDir(tempRoot);
  try {
    if (srcDir !== undefined) {
      if (!statSync(srcDir).isDirectory()) {
        throw profileErrors.invalidItem(`${srcDir} is not a skill directory.`);
      }
      copyDirContentsSync(srcDir, dir);
      rmSync(join(dir, SKILL_FILE), { force: true });
    }
    writeFileSync(join(dir, SKILL_FILE), text, { mode: 0o644 });
    return dir;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function readSkillDocument(dir: string, name: string): { frontmatter: Record<string, unknown>; body: string } {
  let text: string;
  try {
    text = readFileSync(join(dir, SKILL_FILE), "utf8");
  } catch (error) {
    throw profileErrors.invalidItem(`The skill "${name}" has no readable ${SKILL_FILE} (${(error as Error).message}).`);
  }
  try {
    const document = parseMarkdownDocument(text);
    return { frontmatter: document.frontmatter, body: document.body };
  } catch (error) {
    throw profileErrors.invalidItem(`The skill "${name}" has an invalid ${SKILL_FILE}: ${(error as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

function convertSkill(
  item: Extract<PortableItem, { kind: "skill" }>,
  to: AgentProfileAgentId,
  tempRoot: string
): ProfileConversion {
  assertSkillName(item.name);
  const document = readSkillDocument(item.dir, item.name);
  const mapped = mapFrontmatter(document.frontmatter, "skill", to);
  const renamed = Object.keys(mapped.frontmatter).some((key) => !Object.hasOwn(document.frontmatter, key));
  const nameChanged = mapped.frontmatter.name !== item.name;
  // The name keeps its place in the block; a missing one leads it.
  const frontmatter = !nameChanged
    ? mapped.frontmatter
    : Object.hasOwn(mapped.frontmatter, "name")
      ? { ...mapped.frontmatter, name: item.name }
      : { name: item.name, ...mapped.frontmatter };
  const notes = droppedKeysNote(mapped.dropped, to);
  if (mapped.dropped.length === 0 && !renamed && !nameChanged) {
    return { item, notes };
  }
  const dir = writeSkillCopy(tempRoot, serializeMarkdownDocument(frontmatter, document.body), item.dir);
  return { item: { kind: "skill", name: item.name, dir }, notes, tempDir: dir };
}

function convertCommand(
  item: Extract<PortableItem, { kind: "command" }>,
  to: AgentProfileAgentId,
  tempRoot: string
): ProfileConversion {
  assertCommandName(item.name);
  if (to === "codex") {
    const skill = commandToSkillDocument(item.name, item.frontmatter);
    assertSkillName(skill.skillName);
    const dir = writeSkillCopy(tempRoot, serializeMarkdownDocument(skill.frontmatter, item.body));
    return {
      item: { kind: "skill", name: skill.skillName, dir },
      notes: [CODEX_COMMAND_NOTE, ...droppedKeysNote(skill.dropped, to)],
      tempDir: dir
    };
  }
  const notes: string[] = [];
  const name = commandNameFor(item.name, to);
  if (name !== item.name) {
    notes.push(`${label(to)} commands are flat: "${item.name}" is imported as "${name}".`);
  }
  assertCommandName(name);
  const mapped = mapFrontmatter(item.frontmatter, "command", to);
  notes.push(...droppedKeysNote(mapped.dropped, to));
  return { item: { kind: "command", name, frontmatter: mapped.frontmatter, body: item.body }, notes };
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The target's `advanced` extras from the source's (spec §6):
 * - `timeout` (ms: Claude, OpenCode) ↔ `tool_timeout_sec` (s: Codex, Grok) —
 *   ms → s rounds UP, s → ms multiplies by 1000; same-unit agents copy 1:1;
 * - every other key is kept when the target has a field of that name
 *   (`startup_timeout_sec`, `bearer_token_env_var`: Codex ↔ Grok) and dropped
 *   with a note otherwise (`enabled_tools`, `disabled_tools`, `required` are
 *   Codex-only). Only keys are ever named in a note, never values.
 */
export function mapMcpAdvanced(
  advanced: Record<string, unknown> | undefined,
  to: AgentProfileAgentId
): { advanced: Record<string, unknown>; notes: string[] } {
  const targetKeys = new Set(MCP_ADVANCED_FIELDS[to].map((field) => field.key));
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  const notes: string[] = [];
  const put = (key: string, value: unknown, sourceKey: string): void => {
    if (Object.hasOwn(out, key)) {
      dropped.push(sourceKey);
    } else {
      out[key] = value;
    }
  };
  for (const [key, value] of Object.entries(advanced ?? {})) {
    if (value === undefined) continue;
    if (key === "timeout" && !targetKeys.has("timeout") && targetKeys.has("tool_timeout_sec")) {
      const ms = positiveNumber(value);
      if (ms === null) {
        dropped.push(key);
        continue;
      }
      const seconds = Math.ceil(ms / 1000);
      if (seconds * 1000 !== ms) {
        notes.push(`The ${ms} ms timeout was rounded up to ${seconds} s for ${label(to)}.`);
      }
      put("tool_timeout_sec", seconds, key);
    } else if (key === "tool_timeout_sec" && !targetKeys.has("tool_timeout_sec") && targetKeys.has("timeout")) {
      const seconds = positiveNumber(value);
      if (seconds === null) {
        dropped.push(key);
        continue;
      }
      put("timeout", Math.round(seconds * 1000), key);
    } else if (targetKeys.has(key)) {
      put(key, value, key);
    } else {
      dropped.push(key);
    }
  }
  if (dropped.length > 0) {
    notes.unshift(`Dropped MCP settings ${label(to)} does not use: ${dropped.join(", ")}.`);
  }
  return { advanced: out, notes };
}

function convertMcp(server: PortableMcpServer, to: AgentProfileAgentId): ProfileConversion {
  if (!MCP_TRANSPORTS[to].includes(server.transport)) {
    throw profileErrors.invalidItem(
      `${label(to)} does not support ${server.transport} MCP servers, so "${server.name}" cannot be copied there.`
    );
  }
  assertMcpServerName(server.name);
  const mapped = mapMcpAdvanced(server.advanced, to);
  const out: PortableMcpServer = { ...server };
  if (server.args !== undefined) out.args = [...server.args];
  if (server.env !== undefined) out.env = { ...server.env };
  if (server.headers !== undefined) out.headers = { ...server.headers };
  if (Object.keys(mapped.advanced).length > 0) {
    out.advanced = mapped.advanced;
  } else {
    delete out.advanced;
  }
  return { item: { kind: "mcp", server: out }, notes: mapped.notes };
}

/** A converter whose skill copies go under `tempRoot` (see the module header for who removes them). */
export function createProfileConverter(options: ProfileConverterOptions): ProfileConverter {
  return (item, from, to) => {
    if (from === to) {
      return { item, notes: [] };
    }
    switch (item.kind) {
      case "skill":
        return convertSkill(item, to, options.tempRoot);
      case "command":
        return convertCommand(item, to, options.tempRoot);
      case "mcp":
        return convertMcp(item.server, to);
    }
  };
}

/** Default temp root when none is configured: the OS temp dir. */
export const DEFAULT_CONVERT_TEMP_ROOT = join(tmpdir(), "orquester-agent-profile-convert");

/**
 * {@link createProfileConverter} with its copies under the OS temp dir. The
 * daemon should prefer `createProfileConverter({tempRoot: agentProfileImportsDir(appdir)})`
 * so `ProfileImportStore` sweeps what a crash leaks.
 */
export const convertPortableItem: ProfileConverter = createProfileConverter({ tempRoot: DEFAULT_CONVERT_TEMP_ROOT });
