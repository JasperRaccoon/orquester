/**
 * OpenCode 1.18's global profile (spec §3, §4.6): everything under
 * `~/.config/opencode` plus the skills it inherits from `~/.claude/skills` and
 * `~/.agents/skills`.
 *
 * | Kind | Where | Off |
 * |---|---|---|
 * | instructions | `AGENTS.md` | — |
 * | mcp | `mcp.<name>` in the config | `enabled: false` |
 * | skill | `{skills,skill}/<name>/SKILL.md` (+ inherited) | `permission.skill.<name> = "deny"` |
 * | command | `{commands,command}/**\/*.md`, `command.<name>` in the config | stash |
 * | plugin | `plugin[]` in the config, `{plugin,plugins}/*.{js,ts}` | stash |
 *
 * Config edits go through `jsonc.ts` into the file OpenCode itself writes
 * (`config.ts`), comments kept. `plugin/orquester-status.js` is Orquester's own
 * and locked. `opencode serve` caches its config for good, so every mutation
 * notes that servers restart when idle (the service asks the agent host to
 * recycle them, spec §4.8).
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  McpServerDraft,
  MarkdownDocumentDraft,
  PluginInstallDraft,
  ProfileConflictPolicy,
  ProfileInstructionsInfo,
  ProfileItem,
  ProfileItemDetail,
  ProfileItemDraft,
  ProfileItemSource,
  ProfileItemWarning
} from "@orquester/api";
import { AGENT_PROFILE_KINDS } from "@orquester/api";
import { agentProfileImportsDir } from "@orquester/config";
import { profileErrors } from "../../errors.ts";
import {
  type ProfileBackups,
  type ProfileStash,
  type StashEntry,
  SKILL_FILE,
  assertCommandName,
  assertMcpServerName,
  assertSkillName,
  contentHash,
  copyTree,
  isValidCommandName,
  isValidMcpServerName,
  isValidSkillName,
  itemId,
  mergeFrontmatter,
  type MarkdownDocument,
  pathKind,
  readSkillFiles,
  readTextIfExists,
  removeProfilePath,
  writeCommand,
  writeProfileFile,
  writeProfileFileVerified,
  writeSkill
} from "../../infra/index.ts";
import type {
  AdapterMutationResult,
  AdapterSnapshot,
  PortableItem,
  ProfileAdapter,
  ProfileAdapterContext
} from "../types.ts";
import {
  CONFIG_FILE_NAMES,
  type ConfigState,
  agentsOverridingSkill,
  mergedWithTarget,
  permissionConfig,
  readConfigState,
  skillAllowed
} from "./config.ts";
import {
  BOM,
  type JsonObject,
  assertJsoncObject,
  insertJsoncArrayItem,
  insertJsoncMember,
  jsoncValueText,
  isJsonObject,
  parseJsoncObject,
  replaceJsoncObject,
  setJsonc
} from "./jsonc.ts";
import { mcpEntryFromDraft, mcpEntryFromPortable, mcpEntryType, mcpMeta, mcpPortable, mcpView } from "./mcp.ts";
import { type FoundCommand, type FoundSkill, findCommands, findPluginFiles, findSkills, parseOpenCodeDocument } from "./scan.ts";
import {
  checkCommandDraftFrontmatter,
  checkCommandFrontmatter,
  checkPluginSpec,
  isPathSpec,
  pluginPackageKey,
  pluginSpecVersion
} from "./validate.ts";

const AGENT = "opencode";
const LABEL = "OpenCode";

/** Told after every mutation that changes what OpenCode loads. */
export const OPENCODE_RECYCLE_NOTE = "OpenCode servers restart when idle to pick this up.";

/** Orquester's own status plugin (`agent-hooks.ts` rewrites it): listed, never touched. */
export const ORQUESTER_PLUGIN_REL = "plugin/orquester-status.js";

const SKILL_DESCRIPTION_MAX = 1024;

const USER: ProfileItemSource = { type: "user", label: "User" };
const FROM_CLAUDE: ProfileItemSource = { type: "inherited", label: "From Claude", ownerAgent: "claude" };
const SHARED_AGENTS: ProfileItemSource = { type: "inherited", label: "Shared · ~/.agents" };
const ORQUESTER: ProfileItemSource = { type: "orquester", label: "Orquester" };

type SkillOrigin = "own" | "claude" | "agents";

type Entry =
  | { kind: "mcp"; item: ProfileItem; name: string; effective: JsonObject; targetEntry: JsonObject | null }
  | { kind: "skill"; item: ProfileItem; skill: FoundSkill; origin: SkillOrigin; root: string }
  | { kind: "command"; origin: "file"; item: ProfileItem; command: FoundCommand; root: string }
  | { kind: "command"; origin: "config"; item: ProfileItem; name: string; entry: JsonObject; targetEntry: JsonObject | null }
  | { kind: "command" | "plugin"; origin: "stash"; item: ProfileItem; stash: StashEntry }
  | { kind: "plugin"; origin: "config"; item: ProfileItem; spec: string; raw: unknown; index: number }
  | { kind: "plugin"; origin: "file"; item: ProfileItem; file: string; rel: string };

interface Model {
  config: ConfigState;
  entries: Map<string, Entry>;
  /** Where the effective `plugin` list comes from: the target (or nowhere), or another file. */
  pluginListInTarget: boolean;
}

/** The fragment a config command keeps in the stash while off. */
interface CommandFragment {
  origin: "config";
  name: string;
  entry: JsonObject;
  /** The `command` key it followed (`null`: it was first); absent in fragments from before. */
  after?: string | null;
  /** Its value's text as it was written (comments, layout), put back when it still reads the same. */
  text?: string;
}

/** The fragment a `plugin[]` entry keeps in the stash while off. */
interface PluginFragment {
  origin: "config";
  entry: unknown;
  index: number;
  /** The package key of the entry it followed (`null`: it was first); absent in fragments from before. */
  after?: string | null;
  text?: string;
}

function warning(code: string, message: string, action?: ProfileItemWarning["action"]): ProfileItemWarning {
  return action ? { code, message, action } : { code, message };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mutation(itemIds: string[], extra: string[] = []): AdapterMutationResult {
  return { itemIds, notes: [...extra, OPENCODE_RECYCLE_NOTE] };
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

function specOf(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0];
  return null;
}

/** `base-2`, `base-3`, … — the first free name `valid` accepts. */
function keepBothName(base: string, taken: (name: string) => boolean, valid: (name: string) => boolean): string {
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (valid(candidate) && !taken(candidate)) return candidate;
  }
  throw profileErrors.exists(base);
}

export class OpenCodeProfileAdapter implements ProfileAdapter {
  readonly agent = AGENT;
  private readonly ctx: ProfileAdapterContext;
  private readonly backups: ProfileBackups;
  private readonly stash: ProfileStash;

  constructor(ctx: ProfileAdapterContext, deps: { backups: ProfileBackups; stash: ProfileStash }) {
    this.ctx = ctx;
    this.backups = deps.backups;
    this.stash = deps.stash;
  }

  private get dir(): string {
    return this.ctx.homes.opencodeDir;
  }

  private get instructionsPath(): string {
    return join(this.dir, "AGENTS.md");
  }

  watchPaths(): string[] {
    return [
      ...CONFIG_FILE_NAMES.map((name) => join(this.dir, name)),
      this.instructionsPath,
      join(this.dir, "skills"),
      join(this.dir, "skill"),
      join(this.dir, "commands"),
      join(this.dir, "command"),
      join(this.dir, "plugin"),
      join(this.dir, "plugins"),
      join(this.ctx.homes.claudeDir, "skills"),
      this.ctx.homes.agentsSkillsDir,
      join(this.stash.dir, AGENT)
    ];
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async snapshot(): Promise<AdapterSnapshot> {
    const model = await this.load();
    return {
      instructions: (await this.instructionsInfo(model.config)).info,
      items: [...model.entries.values()].map((entry) => entry.item),
      fileErrors: model.config.fileErrors
    };
  }

  private async instructionsInfo(config?: ConfigState): Promise<{ text: string | null; info: ProfileInstructionsInfo }> {
    const path = this.instructionsPath;
    const text = await readTextIfExists(path);
    const warnings: ProfileItemWarning[] = [];
    const state = config ?? (await readConfigState(this.dir));
    if (state.files.length > 1) {
      const others = state.files.filter((file) => file.path !== state.targetPath).map((file) => file.name);
      warnings.push(
        warning(
          "opencode-several-config-files",
          `OpenCode merges ${state.files.map((file) => file.name).join(", ")}; changes are written to ${state.targetName}, which wins over ${others.join(" and ")}.`,
          "open-file"
        )
      );
    }
    if (text === null) {
      return { text, info: { path, exists: false, bytes: 0, lines: 0, revision: "", warnings } };
    }
    const st = await stat(path);
    return {
      text,
      info: {
        path,
        exists: true,
        bytes: Buffer.byteLength(text),
        lines: lineCount(text),
        mtime: st.mtime.toISOString(),
        revision: contentHash(text),
        warnings
      }
    };
  }

  private async load(): Promise<Model> {
    const config = await readConfigState(this.dir);
    const entries = new Map<string, Entry>();
    const add = (entry: Entry): void => {
      entries.set(entry.item.id, entry);
    };
    this.loadMcp(config, add);
    await this.loadSkills(config, entries, add);
    const stashed = await this.stash.list(AGENT);
    await this.loadCommands(config, entries, add, stashed);
    const pluginListInTarget = await this.loadPlugins(config, entries, add, stashed);
    return { config, entries, pluginListInTarget };
  }

  private loadMcp(config: ConfigState, add: (entry: Entry) => void): void {
    const servers = isJsonObject(config.merged.mcp) ? config.merged.mcp : {};
    const targetMcp = isJsonObject(config.targetValue?.mcp) ? config.targetValue.mcp : {};
    for (const [name, effective] of Object.entries(servers)) {
      if (!isJsonObject(effective)) continue;
      const files = config.files.filter((file) => isJsonObject(file.value?.mcp) && name in (file.value.mcp as JsonObject));
      const definedIn = files.filter((file) => mcpEntryType((file.value!.mcp as JsonObject)[name]) !== null);
      const elsewhere = files.filter((file) => file.path !== config.targetPath);
      const definition = mcpEntryType(effective) !== null;
      const enabled = effective.enabled !== false;
      const warnings: ProfileItemWarning[] = [];
      if (!definition) {
        warnings.push(
          warning("opencode-mcp-override-only", "Only an on/off override is set here: the server itself is not defined in the global config.")
        );
      }
      if (elsewhere.length > 0) {
        warnings.push(
          warning(
            "opencode-defined-in-other-file",
            `Also set in ${elsewhere.map((file) => file.name).join(", ")}; edit it there.`,
            "open-file"
          )
        );
      }
      const targetEntry = isJsonObject(targetMcp[name]) ? (targetMcp[name] as JsonObject) : null;
      const onlyInTarget = elsewhere.length === 0;
      add({
        kind: "mcp",
        name,
        effective,
        targetEntry,
        item: {
          id: itemId("mcp", name),
          kind: "mcp",
          name,
          enabled,
          toggleable: !config.broken,
          editable: !config.broken && definition && onlyInTarget,
          deletable: !config.broken && onlyInTarget,
          locked: false,
          source: USER,
          path: (definedIn.at(-1) ?? files.at(-1))?.path ?? config.targetPath,
          revision: contentHash({ effective, enabled, files: files.map((file) => file.name) }),
          warnings,
          meta: mcpMeta(effective)
        }
      });
    }
  }

  private async loadSkills(
    config: ConfigState,
    entries: Map<string, Entry>,
    add: (entry: Entry) => void
  ): Promise<void> {
    const roots: { root: string; origin: SkillOrigin; dot: boolean }[] = [
      { root: join(this.dir, "skills"), origin: "own", dot: false },
      { root: join(this.dir, "skill"), origin: "own", dot: false },
      { root: join(this.ctx.homes.claudeDir, "skills"), origin: "claude", dot: true },
      { root: this.ctx.homes.agentsSkillsDir, origin: "agents", dot: true }
    ];
    // One item per name, the own copy first; OpenCode loads one of the others at random.
    const others = new Map<string, string[]>();
    for (const { root, origin, dot } of roots) {
      for (const skill of await findSkills(root, { dot })) {
        const id = itemId("skill", skill.name);
        if (entries.has(id)) {
          others.set(id, [...(others.get(id) ?? []), skill.dir]);
          continue;
        }
        add(this.skillEntry(config, skill, origin, root));
      }
    }
    for (const [id, dirs] of others) {
      const entry = entries.get(id)!;
      entry.item.warnings.push(
        warning(
          "opencode-skill-duplicate",
          dirs.length === 1
            ? `Another skill named "${entry.item.name}" is at ${dirs[0]}; OpenCode loads only one of them.`
            : `${dirs.length} other skills are named "${entry.item.name}" (${dirs.join(", ")}); OpenCode loads only one of them.`
        )
      );
    }
  }

  private skillEntry(config: ConfigState, skill: FoundSkill, origin: SkillOrigin, root: string): Entry {
    const warnings: ProfileItemWarning[] = [];
    if (skill.error !== undefined) {
      warnings.push(warning("opencode-skill-unreadable", `OpenCode skips it: ${skill.error}`, "open-file"));
    } else if (!skill.named) {
      warnings.push(warning("opencode-skill-no-name", "OpenCode skips it: its SKILL.md has no name.", "open-file"));
    } else if (skill.frontmatter.description !== undefined && typeof skill.frontmatter.description !== "string") {
      warnings.push(
        warning(
          "opencode-skill-invalid",
          "OpenCode skips it: its description is not read as text (YAML 1.1 takes it for a date or a number); quote it.",
          "open-file"
        )
      );
    } else if (skill.description === undefined) {
      warnings.push(warning("opencode-skill-no-description", "No description: OpenCode does not offer it to the model."));
    }
    const folder = skill.rel.split("/").at(-1) ?? "";
    if (skill.named && skill.rel !== "" && folder !== skill.name) {
      warnings.push(warning("opencode-skill-name-mismatch", `Its folder is "${folder}" but its name is "${skill.name}".`));
    }
    const own = origin === "own";
    const plainOwn = own && skill.rel !== "" && !skill.rel.includes("/");
    const editable = plainOwn && skill.error === undefined && folder === skill.name && isValidSkillName(skill.name);
    const toggleable = skill.named && !/[*?]/.test(skill.name) && !config.broken;
    const enabled = skill.named ? skillAllowed(config.merged, skill.name) : false;
    const overriding = skill.named ? agentsOverridingSkill(config.merged, skill.name) : [];
    if (overriding.length > 0) {
      warnings.push(
        warning(
          "opencode-skill-agent-override",
          `The ${overriding.join(", ")} agent's own permission rules turn it ${enabled ? "off" : "on"} there, whatever this switch says.`,
          "open-file"
        )
      );
    }
    return {
      kind: "skill",
      skill,
      origin,
      root,
      item: {
        id: itemId("skill", skill.name),
        kind: "skill",
        name: skill.name,
        ...(skill.description !== undefined ? { description: skill.description } : {}),
        enabled,
        toggleable,
        editable,
        deletable: plainOwn,
        locked: false,
        source: origin === "own" ? USER : origin === "claude" ? FROM_CLAUDE : SHARED_AGENTS,
        path: skill.dir,
        revision: contentHash({ text: skill.text, path: skill.skillFile, enabled }),
        warnings
      }
    };
  }

  private async loadCommands(
    config: ConfigState,
    entries: Map<string, Entry>,
    add: (entry: Entry) => void,
    stashed: StashEntry[]
  ): Promise<void> {
    // `commands/` sorts after `command/` in OpenCode's scan, so it wins a name clash.
    for (const folder of ["commands", "command"]) {
      const root = join(this.dir, folder);
      for (const command of await findCommands(root)) {
        const id = itemId("command", command.name);
        const existing = entries.get(id);
        if (existing !== undefined) {
          existing.item.warnings.push(
            warning("opencode-command-duplicate", `${command.file} has the same name; OpenCode uses this one.`)
          );
          continue;
        }
        add(this.commandFileEntry(command, root));
      }
    }
    const commands = isJsonObject(config.merged.command) ? config.merged.command : {};
    const targetCommands = isJsonObject(config.targetValue?.command) ? config.targetValue.command : {};
    for (const [name, entry] of Object.entries(commands)) {
      if (!isJsonObject(entry)) continue;
      const id = itemId("command", name);
      const existing = entries.get(id);
      if (existing !== undefined) {
        existing.item.warnings.push(
          warning("opencode-command-duplicate", `"command.${name}" in the config is also set; this file's settings win.`)
        );
        continue;
      }
      const elsewhere = config.files.filter(
        (file) => file.path !== config.targetPath && isJsonObject(file.value?.command) && name in (file.value.command as JsonObject)
      );
      const onlyInTarget = elsewhere.length === 0;
      const warnings: ProfileItemWarning[] = [];
      if (!onlyInTarget) {
        warnings.push(
          warning("opencode-defined-in-other-file", `Set in ${elsewhere.map((file) => file.name).join(", ")}; edit it there.`, "open-file")
        );
      }
      const description = typeof entry.description === "string" && entry.description.trim() ? entry.description.trim() : undefined;
      add({
        kind: "command",
        origin: "config",
        name,
        entry,
        targetEntry: isJsonObject(targetCommands[name]) ? (targetCommands[name] as JsonObject) : null,
        item: {
          id,
          kind: "command",
          name,
          ...(description !== undefined ? { description } : {}),
          enabled: true,
          toggleable: !config.broken && onlyInTarget,
          editable: !config.broken && onlyInTarget,
          deletable: !config.broken && onlyInTarget,
          locked: false,
          source: USER,
          path: elsewhere.at(-1)?.path ?? config.targetPath,
          revision: contentHash({ entry, enabled: true }),
          warnings,
          meta: { in: "config" }
        }
      });
    }
    this.addStashed("command", stashed, entries, add);
  }

  private commandFileEntry(command: FoundCommand, root: string): Entry {
    const warnings: ProfileItemWarning[] = [];
    if (command.error !== undefined) {
      warnings.push(warning("opencode-command-unreadable", `OpenCode skips it: ${command.error}`, "open-file"));
    } else {
      try {
        checkCommandFrontmatter(command.frontmatter);
      } catch (error) {
        warnings.push(warning("opencode-command-invalid", `OpenCode cannot load its config with this file: ${message(error)}`, "open-file"));
      }
    }
    if (command.invokedAs !== undefined) {
      warnings.push(
        warning("opencode-command-renamed", `Its frontmatter names it "${command.invokedAs}": OpenCode runs it as /${command.invokedAs}.`, "open-file")
      );
    }
    return {
      kind: "command",
      origin: "file",
      command,
      root,
      item: {
        id: itemId("command", command.name),
        kind: "command",
        name: command.name,
        ...(command.description !== undefined ? { description: command.description } : {}),
        enabled: true,
        toggleable: true,
        editable: command.error === undefined && isValidCommandName(command.name),
        deletable: true,
        locked: false,
        source: USER,
        path: command.file,
        revision: contentHash({ text: command.text, path: command.file, enabled: true }),
        warnings
      }
    };
  }

  private addStashed(
    kind: "command" | "plugin",
    stashed: StashEntry[],
    entries: Map<string, Entry>,
    add: (entry: Entry) => void
  ): void {
    for (const entry of stashed) {
      if (entry.kind !== kind) continue;
      const live = entries.get(entry.id);
      if (live !== undefined) {
        live.item.warnings.push(
          warning("opencode-stashed-copy", "A turned-off copy is also kept aside; delete that copy before turning this one off.")
        );
        continue;
      }
      const description = typeof entry.meta?.description === "string" ? entry.meta.description : undefined;
      add({
        kind,
        origin: "stash",
        stash: entry,
        item: {
          id: entry.id,
          kind,
          name: entry.name,
          ...(description !== undefined ? { description } : {}),
          enabled: false,
          toggleable: true,
          editable: false,
          deletable: true,
          locked: false,
          stashed: true,
          source: USER,
          ...(entry.payloadPath !== null ? { path: entry.payloadPath } : {}),
          revision: contentHash({ stashed: entry.original, stashedAt: entry.stashedAt, enabled: false }),
          warnings: [],
          ...(kind === "plugin" ? { meta: { source: entry.original.type === "path" ? "file" : "config" } } : {})
        }
      });
    }
  }

  /** Answers whether the effective `plugin` list is the target's own (or there is none). */
  private async loadPlugins(
    config: ConfigState,
    entries: Map<string, Entry>,
    add: (entry: Entry) => void,
    stashed: StashEntry[]
  ): Promise<boolean> {
    const owner = config.files.filter((file) => file.value !== null && "plugin" in file.value).at(-1);
    const inTarget = owner === undefined || owner.path === config.targetPath;
    const list = Array.isArray(config.merged.plugin) ? config.merged.plugin : [];
    const editable = inTarget && !config.broken;
    list.forEach((raw, index) => {
      const spec = specOf(raw);
      if (spec === null) return;
      const id = itemId("plugin", spec);
      const existing = entries.get(id);
      if (existing !== undefined) {
        existing.item.warnings.push(warning("opencode-plugin-duplicate", "Listed more than once in the config."));
        return;
      }
      const version = pluginSpecVersion(spec);
      const warnings: ProfileItemWarning[] = [];
      if (!inTarget && owner !== undefined) {
        warnings.push(warning("opencode-defined-in-other-file", `Listed in ${owner.name}; change it there.`, "open-file"));
      }
      add({
        kind: "plugin",
        origin: "config",
        spec,
        raw,
        index,
        item: {
          id,
          kind: "plugin",
          name: spec,
          enabled: true,
          toggleable: editable,
          editable: false,
          deletable: editable,
          locked: false,
          source: USER,
          path: owner?.path ?? config.targetPath,
          revision: contentHash({ raw, index, enabled: true }),
          warnings,
          meta: {
            source: isPathSpec(spec) ? "file" : "npm",
            ...(version !== undefined ? { version } : {}),
            ...(Array.isArray(raw) ? { options: "yes" } : {})
          }
        }
      });
    });
    for (const folder of ["plugin", "plugins"]) {
      for (const found of await findPluginFiles(join(this.dir, folder))) {
        const rel = `${folder}/${found.name}`;
        const id = itemId("plugin", rel);
        if (entries.has(id)) continue;
        const locked = rel === ORQUESTER_PLUGIN_REL;
        let text = "";
        try {
          text = await readFile(found.file, "utf8");
        } catch {
          text = "";
        }
        add({
          kind: "plugin",
          origin: "file",
          file: found.file,
          rel,
          item: {
            id,
            kind: "plugin",
            name: found.name,
            enabled: true,
            toggleable: !locked,
            editable: false,
            deletable: !locked,
            locked,
            source: locked ? ORQUESTER : USER,
            path: found.file,
            revision: contentHash({ text, path: found.file, enabled: true }),
            warnings: [],
            meta: { source: "file" }
          }
        });
      }
    }
    this.addStashed("plugin", stashed, entries, add);
    return inTarget;
  }

  async readItem(id: string): Promise<ProfileItemDetail> {
    const model = await this.load();
    const entry = this.find(model, id);
    switch (entry.kind) {
      case "mcp":
        return { kind: "mcp", item: entry.item, mcp: mcpView(entry.name, entry.effective) };
      case "skill":
        return {
          kind: "skill",
          item: entry.item,
          document: { frontmatter: entry.skill.frontmatter, body: entry.skill.body },
          files: await readSkillFiles(entry.skill.dir)
        };
      case "command":
        return { kind: "command", item: entry.item, document: await this.commandDocument(entry) };
      case "plugin": {
        const spec = entry.origin === "config" ? entry.spec : entry.item.name;
        const version = entry.origin === "config" ? pluginSpecVersion(spec) : undefined;
        return {
          kind: "plugin",
          item: entry.item,
          plugin: { id: entry.item.id, name: spec, ...(version !== undefined ? { version } : {}) }
        };
      }
    }
  }

  private async commandDocument(
    entry: Extract<Entry, { kind: "command" }> | Extract<Entry, { origin: "stash" }>
  ): Promise<{ frontmatter: Record<string, unknown>; body: string }> {
    if (entry.origin === "file") {
      return { frontmatter: entry.command.frontmatter, body: entry.command.body };
    }
    if (entry.origin === "config") {
      const { template, ...frontmatter } = entry.entry;
      return { frontmatter, body: typeof template === "string" ? template : "" };
    }
    const stash = entry.stash;
    if (stash.payloadPath !== null) {
      const doc = parseOpenCodeDocument(await readFile(stash.payloadPath, "utf8"));
      return { frontmatter: doc.frontmatter, body: doc.body };
    }
    const data = stash.original.type === "fragment" ? (stash.original.data as Partial<CommandFragment>) : {};
    const { template, ...frontmatter } = isJsonObject(data.entry) ? data.entry : {};
    return { frontmatter, body: typeof template === "string" ? template : "" };
  }

  async readInstructions(): Promise<{ text: string; info: ProfileInstructionsInfo }> {
    const { text, info } = await this.instructionsInfo();
    return { text: text ?? "", info };
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  private find(model: Model, id: string): Entry {
    const entry = model.entries.get(id);
    if (entry === undefined) {
      throw profileErrors.notFound(id);
    }
    return entry;
  }

  private checked(model: Model, id: string, revision: string): Entry {
    const entry = this.find(model, id);
    if (entry.item.revision !== revision) {
      throw profileErrors.conflict();
    }
    if (entry.item.locked) {
      throw profileErrors.locked(entry.item.name);
    }
    return entry;
  }

  /** Refuses any config write while a config file does not parse (what OpenCode loads is unknown). */
  private requireConfig(config: ConfigState): void {
    const broken = config.files.find((file) => file.value === null);
    if (broken !== undefined) {
      throw profileErrors.unreadable(broken.path, broken.error ?? "it does not parse");
    }
  }

  private async writeConfig(config: ConfigState, text: string): Promise<void> {
    this.requireConfig(config);
    await writeProfileFileVerified(config.targetPath, config.targetBom ? `${BOM}${text}` : text, {
      backups: this.backups,
      agent: AGENT,
      // It holds MCP secrets: a new file is the owner's alone.
      defaultMode: 0o600,
      verify: assertJsoncObject
    });
  }

  async create(draft: ProfileItemDraft, options: { onConflict: ProfileConflictPolicy }): Promise<AdapterMutationResult> {
    if (!isJsonObject(draft) || !(AGENT_PROFILE_KINDS.opencode as readonly string[]).includes(draft.kind)) {
      throw profileErrors.kindNotSupported(LABEL, String((draft as { kind?: unknown })?.kind));
    }
    const policy = options.onConflict ?? "fail";
    switch (draft.kind) {
      case "mcp":
        return this.createMcp(draft.mcp, null, policy);
      case "skill":
        return this.createSkill(draft.document, policy);
      case "command":
        return this.createCommand(draft.document, policy);
      case "plugin":
        return this.installPlugin(draft.plugin, policy);
      default:
        throw profileErrors.kindNotSupported(LABEL, draft.kind);
    }
  }

  private async createMcp(
    draft: McpServerDraft | undefined,
    portable: JsonObject | null,
    policy: ProfileConflictPolicy
  ): Promise<AdapterMutationResult> {
    if (!isJsonObject(draft) || typeof draft.name !== "string") {
      throw profileErrors.invalidItem("An MCP server needs a name.");
    }
    assertMcpServerName(draft.name);
    const model = await this.load();
    this.requireConfig(model.config);
    let name = draft.name;
    const taken = (candidate: string): boolean => model.entries.has(itemId("mcp", candidate));
    let replacing: Extract<Entry, { kind: "mcp" }> | null = null;
    if (taken(name)) {
      if (policy === "fail") throw profileErrors.exists(name);
      if (policy === "keep-both") {
        name = keepBothName(name, taken, isValidMcpServerName);
      } else {
        const existing = model.entries.get(itemId("mcp", name)) as Extract<Entry, { kind: "mcp" }>;
        if (!existing.item.deletable) throw profileErrors.notEditable(name);
        replacing = existing;
      }
    }
    const entry = portable ?? mcpEntryFromDraft({ ...draft, name }, null);
    const text =
      replacing !== null && replacing.targetEntry !== null
        ? replaceJsoncObject(model.config.targetText, ["mcp", name], replacing.targetEntry, entry)
        : setJsonc(model.config.targetText, ["mcp", name], entry);
    await this.writeConfig(model.config, text);
    return mutation([itemId("mcp", name)]);
  }

  private skillsRoot(): string {
    return join(this.dir, "skills");
  }

  private checkSkillDescription(frontmatter: Record<string, unknown>): void {
    const description = frontmatter.description;
    if (typeof description !== "string" || description.trim().length === 0) {
      throw profileErrors.invalidItem("OpenCode needs a description for every skill.");
    }
    if (description.length > SKILL_DESCRIPTION_MAX) {
      throw profileErrors.invalidItem(`A skill's description can be at most ${SKILL_DESCRIPTION_MAX} characters.`);
    }
  }

  /** The skill name to create under, after the conflict policy; `replace` removes the one it replaces. */
  private async claimSkillName(model: Model, name: string, policy: ProfileConflictPolicy): Promise<string> {
    assertSkillName(name);
    const taken = (candidate: string): boolean => model.entries.has(itemId("skill", candidate));
    const onDisk = async (candidate: string): Promise<boolean> =>
      (await pathKind(join(this.skillsRoot(), candidate))) !== null;
    if (!taken(name) && !(await onDisk(name))) return name;
    if (policy === "fail") throw profileErrors.exists(name);
    if (policy === "keep-both") {
      for (let n = 2; n < 1000; n += 1) {
        const candidate = `${name}-${n}`;
        if (isValidSkillName(candidate) && !taken(candidate) && !(await onDisk(candidate))) return candidate;
      }
      throw profileErrors.exists(name);
    }
    const existing = model.entries.get(itemId("skill", name));
    if (existing === undefined) {
      // The folder is taken by a skill of another name (OpenCode knows skills by their
      // frontmatter name), or by something that is not a skill: replacing would delete it.
      throw profileErrors.invalidItem(
        `${join(this.skillsRoot(), name)} holds something other than the skill "${name}"; rename or delete it first.`
      );
    }
    if (existing.kind !== "skill" || !existing.item.deletable || existing.skill.dir !== join(this.skillsRoot(), name)) {
      throw profileErrors.invalidItem(`"${name}" (${existing.item.source.label}) cannot be replaced from here.`);
    }
    await removeProfilePath(join(this.skillsRoot(), name), { backups: this.backups, agent: AGENT });
    return name;
  }

  private skillNotes(config: ConfigState, name: string): string[] {
    return skillAllowed(config.merged, name) ? [] : [`"${name}" is turned off by a permission rule; turn it on here to use it.`];
  }

  private async createSkill(document: MarkdownDocumentDraft | undefined, policy: ProfileConflictPolicy): Promise<AdapterMutationResult> {
    if (!isJsonObject(document) || typeof document.name !== "string") {
      throw profileErrors.invalidItem("A skill needs a name.");
    }
    assertSkillName(document.name);
    const frontmatter = mergeFrontmatter({}, isJsonObject(document.frontmatter) ? document.frontmatter : {});
    this.checkSkillDescription(frontmatter);
    const model = await this.load();
    const name = await this.claimSkillName(model, document.name, policy);
    await writeSkill(
      this.skillsRoot(),
      { name, frontmatter, body: typeof document.body === "string" ? document.body : "" },
      { backups: this.backups, agent: AGENT, mergeExisting: false, yaml: "1.1" }
    );
    return mutation([itemId("skill", name)], this.skillNotes(model.config, name));
  }

  private commandsRoot(): string {
    return join(this.dir, "commands");
  }

  private async claimCommandName(model: Model, name: string, policy: ProfileConflictPolicy): Promise<{ name: string; replace: boolean }> {
    assertCommandName(name);
    // A file whose frontmatter `name` is this one already owns it in OpenCode.
    const renamedTo = new Set(
      [...model.entries.values()].flatMap((entry) =>
        entry.kind === "command" && entry.origin === "file" && entry.command.invokedAs !== undefined ? [entry.command.invokedAs] : []
      )
    );
    const taken = (candidate: string): boolean => model.entries.has(itemId("command", candidate)) || renamedTo.has(candidate);
    if (!taken(name)) return { name, replace: false };
    if (policy === "fail") throw profileErrors.exists(name);
    if (policy === "keep-both") return { name: keepBothName(name, taken, isValidCommandName), replace: false };
    const existing = model.entries.get(itemId("command", name));
    if (
      existing === undefined ||
      renamedTo.has(name) ||
      existing.kind !== "command" ||
      existing.origin !== "file" ||
      existing.root !== this.commandsRoot() ||
      !existing.item.editable
    ) {
      throw profileErrors.invalidItem(`"${name}" cannot be replaced from here: turn it on or delete it first.`);
    }
    return { name, replace: true };
  }

  private async createCommand(document: MarkdownDocumentDraft | undefined, policy: ProfileConflictPolicy): Promise<AdapterMutationResult> {
    if (!isJsonObject(document) || typeof document.name !== "string") {
      throw profileErrors.invalidItem("A command needs a name.");
    }
    assertCommandName(document.name);
    const frontmatter = mergeFrontmatter({}, checkCommandDraftFrontmatter(document.frontmatter));
    checkCommandFrontmatter(frontmatter);
    const model = await this.load();
    const { name } = await this.claimCommandName(model, document.name, policy);
    await writeCommand(
      this.commandsRoot(),
      { name, frontmatter, body: typeof document.body === "string" ? document.body : "" },
      { backups: this.backups, agent: AGENT, mergeExisting: false, yaml: "1.1" }
    );
    return mutation([itemId("command", name)]);
  }

  private async installPlugin(draft: PluginInstallDraft | undefined, policy: ProfileConflictPolicy): Promise<AdapterMutationResult> {
    if (!isJsonObject(draft) || !("spec" in draft)) {
      throw profileErrors.invalidItem("OpenCode plugins are npm packages or local files, not marketplace plugins.");
    }
    const spec = await checkPluginSpec(draft.spec, this.ctx.homes.home);
    if (isPathSpec(spec)) {
      // OpenCode already loads Orquester's status plugin from its folder: listing it too would run it twice.
      const real = await realpath(spec.startsWith("file://") ? fileURLToPath(spec) : spec).catch(() => null);
      const locked = await realpath(join(this.dir, ORQUESTER_PLUGIN_REL)).catch(() => null);
      if (real !== null && real === locked) throw profileErrors.locked(ORQUESTER_PLUGIN_REL);
    }
    const model = await this.load();
    this.requireConfig(model.config);
    if (!model.pluginListInTarget) {
      throw profileErrors.invalidItem(
        `The plugin list OpenCode uses is in another config file than ${model.config.targetName}; add the plugin there.`
      );
    }
    const target = model.config.targetValue ?? {};
    if (target.plugin !== undefined && !Array.isArray(target.plugin)) {
      throw profileErrors.unreadable(model.config.targetPath, '"plugin" is not a list');
    }
    const list = Array.isArray(target.plugin) ? [...target.plugin] : [];
    const key = pluginPackageKey(spec);
    const clash = list.findIndex((raw) => {
      const other = specOf(raw);
      return other !== null && pluginPackageKey(other) === key;
    });
    let text = model.config.targetText;
    if (clash >= 0) {
      if (policy === "fail") throw profileErrors.exists(key);
      if (policy === "keep-both") throw profileErrors.invalidItem(`"${key}" is already installed; a plugin cannot be listed twice.`);
      text = setJsonc(text, ["plugin", clash], undefined);
      list.splice(clash, 1);
    }
    text = Array.isArray(target.plugin)
      ? insertJsoncArrayItem(text, ["plugin"], list.length, spec)
      : setJsonc(text, ["plugin"], [spec]);
    await this.writeConfig(model.config, text);
    const notes = isPathSpec(spec) ? [] : ["OpenCode installs npm plugins when its server starts."];
    return mutation([itemId("plugin", spec)], notes);
  }

  async update(id: string, revision: string, draft: ProfileItemDraft): Promise<AdapterMutationResult> {
    const model = await this.load();
    const entry = this.checked(model, id, revision);
    if (!entry.item.editable) {
      throw profileErrors.notEditable(entry.item.name);
    }
    if (!isJsonObject(draft) || draft.kind !== entry.kind) {
      throw profileErrors.invalidItem(`The draft is not a ${entry.kind}.`);
    }
    if (entry.kind === "mcp" && draft.kind === "mcp") {
      return this.updateMcp(model, entry, draft.mcp);
    }
    if (entry.kind === "skill" && draft.kind === "skill") {
      return this.updateSkill(model, entry, draft.document);
    }
    if (entry.kind === "command" && draft.kind === "command" && entry.origin === "file") {
      return this.updateCommandFile(model, entry, draft.document);
    }
    if (entry.kind === "command" && draft.kind === "command" && entry.origin === "config") {
      return this.updateCommandConfig(model, entry, draft.document);
    }
    throw profileErrors.notEditable(entry.item.name);
  }

  private async updateMcp(
    model: Model,
    entry: Extract<Entry, { kind: "mcp" }>,
    draft: McpServerDraft | undefined
  ): Promise<AdapterMutationResult> {
    if (!isJsonObject(draft) || typeof draft.name !== "string") {
      throw profileErrors.invalidItem("An MCP server needs a name.");
    }
    this.requireConfig(model.config);
    const next = mcpEntryFromDraft(draft, entry.targetEntry);
    let text = model.config.targetText;
    if (draft.name !== entry.name) {
      assertMcpServerName(draft.name);
      if (model.entries.has(itemId("mcp", draft.name))) throw profileErrors.exists(draft.name);
      text = setJsonc(text, ["mcp", entry.name], undefined);
      text = setJsonc(text, ["mcp", draft.name], next);
    } else {
      text = replaceJsoncObject(text, ["mcp", entry.name], entry.targetEntry, next);
    }
    await this.writeConfig(model.config, text);
    return mutation([itemId("mcp", draft.name)]);
  }

  private async updateSkill(
    model: Model,
    entry: Extract<Entry, { kind: "skill" }>,
    document: MarkdownDocumentDraft | undefined
  ): Promise<AdapterMutationResult> {
    if (!isJsonObject(document) || typeof document.name !== "string") {
      throw profileErrors.invalidItem("A skill needs a name.");
    }
    const draftFrontmatter = isJsonObject(document.frontmatter) ? document.frontmatter : {};
    const merged = mergeFrontmatter(entry.skill.frontmatter, draftFrontmatter);
    this.checkSkillDescription(merged);
    const body = typeof document.body === "string" ? document.body : entry.skill.body;
    const root = dirname(entry.skill.dir);
    if (document.name === entry.skill.name) {
      // `merged` is the file's frontmatter as OpenCode reads it (its colon fallback included).
      await writeSkill(root, { name: entry.skill.name, frontmatter: merged, body }, {
        backups: this.backups,
        agent: AGENT,
        mergeExisting: false,
        yaml: "1.1"
      });
      return mutation([entry.item.id]);
    }
    assertSkillName(document.name);
    const newDir = join(root, document.name);
    if (model.entries.has(itemId("skill", document.name)) || (await pathKind(newDir)) !== null) {
      throw profileErrors.exists(document.name);
    }
    const copied = await copyTree(entry.skill.dir, newDir, { refuseSymlinks: false });
    await writeSkill(root, { name: document.name, frontmatter: { ...merged, name: document.name }, body }, {
      backups: this.backups,
      agent: AGENT,
      mergeExisting: false,
      yaml: "1.1"
    });
    await removeProfilePath(entry.skill.dir, { backups: this.backups, agent: AGENT });
    const notes = copied.skipped.length > 0 ? [`Left out while renaming (symlinks): ${copied.skipped.join(", ")}.`] : [];
    return mutation([itemId("skill", document.name)], [...notes, ...this.skillNotes(model.config, document.name)]);
  }

  private async updateCommandFile(
    model: Model,
    entry: Extract<Entry, { kind: "command"; origin: "file" }>,
    document: MarkdownDocumentDraft | undefined
  ): Promise<AdapterMutationResult> {
    if (!isJsonObject(document) || typeof document.name !== "string") {
      throw profileErrors.invalidItem("A command needs a name.");
    }
    const draftFrontmatter = checkCommandDraftFrontmatter(document.frontmatter);
    const merged = mergeFrontmatter(entry.command.frontmatter, draftFrontmatter);
    checkCommandFrontmatter(merged);
    const body = typeof document.body === "string" ? document.body : entry.command.body;
    if (document.name === entry.command.name) {
      await writeCommand(entry.root, { name: entry.command.name, frontmatter: merged, body }, {
        backups: this.backups,
        agent: AGENT,
        mergeExisting: false,
        yaml: "1.1"
      });
      return mutation([entry.item.id]);
    }
    assertCommandName(document.name);
    if (model.entries.has(itemId("command", document.name))) {
      throw profileErrors.exists(document.name);
    }
    await writeCommand(entry.root, { name: document.name, frontmatter: merged, body }, {
      backups: this.backups,
      agent: AGENT,
      mergeExisting: false,
      yaml: "1.1"
    });
    await removeProfilePath(entry.command.file, { backups: this.backups, agent: AGENT });
    return mutation([itemId("command", document.name)]);
  }

  private async updateCommandConfig(
    model: Model,
    entry: Extract<Entry, { kind: "command"; origin: "config" }>,
    document: MarkdownDocumentDraft | undefined
  ): Promise<AdapterMutationResult> {
    if (!isJsonObject(document) || typeof document.name !== "string") {
      throw profileErrors.invalidItem("A command needs a name.");
    }
    this.requireConfig(model.config);
    const draftFrontmatter = checkCommandDraftFrontmatter(document.frontmatter);
    const { template: _template, ...current } = entry.targetEntry ?? entry.entry;
    const merged = mergeFrontmatter(current, draftFrontmatter);
    checkCommandFrontmatter(merged);
    const body = typeof document.body === "string" ? document.body : typeof _template === "string" ? _template : "";
    const next: JsonObject = { template: body, ...merged };
    let text = model.config.targetText;
    if (document.name !== entry.name) {
      assertCommandName(document.name);
      if (model.entries.has(itemId("command", document.name))) throw profileErrors.exists(document.name);
      text = setJsonc(text, ["command", entry.name], undefined);
      text = setJsonc(text, ["command", document.name], next);
    } else {
      text = replaceJsoncObject(text, ["command", entry.name], entry.targetEntry, next);
    }
    await this.writeConfig(model.config, text);
    return mutation([itemId("command", document.name)]);
  }

  async setEnabled(id: string, revision: string, enabled: boolean): Promise<AdapterMutationResult> {
    const model = await this.load();
    const entry = this.checked(model, id, revision);
    if (!entry.item.toggleable) {
      throw profileErrors.notToggleable(entry.item.name);
    }
    if (entry.item.enabled === enabled) {
      return { itemIds: [id], notes: [] };
    }
    switch (entry.kind) {
      case "mcp":
        return this.toggleMcp(model, entry, enabled);
      case "skill":
        return this.toggleSkill(model, entry, enabled);
      case "command":
      case "plugin":
        if (entry.origin === "stash") {
          return this.restoreStashed(model, entry);
        }
        return this.stashItem(model, entry);
    }
  }

  private async toggleMcp(model: Model, entry: Extract<Entry, { kind: "mcp" }>, enabled: boolean): Promise<AdapterMutationResult> {
    this.requireConfig(model.config);
    const path = ["mcp", entry.name];
    let text = model.config.targetText;
    const target = entry.targetEntry;
    if (target !== null && "disabled" in target) {
      // The newer spelling of the switch: this module writes `enabled`, so the two never disagree.
      text = setJsonc(text, [...path, "disabled"], undefined);
    }
    if (!enabled) {
      text = setJsonc(text, [...path, "enabled"], false);
    } else {
      if (target !== null && mcpEntryType(target) === null && Object.keys(target).every((key) => key === "enabled" || key === "disabled")) {
        // An override with nothing else in it: drop it whole.
        text = setJsonc(text, path, undefined);
      } else if (target !== null && "enabled" in target) {
        text = setJsonc(text, [...path, "enabled"], true);
      }
      const merged = mergedWithTarget(model.config, text);
      const effective = isJsonObject(merged.mcp) ? merged.mcp[entry.name] : undefined;
      if (isJsonObject(effective) && effective.enabled === false) {
        // Another file turns it off: the target (loaded last) turns it back on.
        text = setJsonc(text, [...path, "enabled"], true);
      }
    }
    const after = mergedWithTarget(model.config, text);
    const effective = isJsonObject(after.mcp) ? after.mcp[entry.name] : undefined;
    // (An override-only entry that is dropped leaves nothing: fine when turning on.)
    if (isJsonObject(effective) ? (effective.enabled !== false) !== enabled : !enabled) {
      throw profileErrors.invalidItem(`The config still turns "${entry.name}" ${enabled ? "off" : "on"} after this edit; change it by hand.`);
    }
    await this.writeConfig(model.config, text);
    return mutation([entry.item.id]);
  }

  /**
   * Sets `permission.skill.<name>` in `text` to `action` (moved to the end, so
   * it is the last rule for that name) or, with `undefined`, removes it. An
   * action string in `permission` or `permission.skill` is first rewritten to
   * the object form OpenCode decodes it to (`{"*": action}`), which means the
   * same.
   */
  private skillPermissionEdit(text: string, name: string, action: "deny" | "allow" | undefined, inherited?: string): string {
    const parsed = parseJsoncObject(text);
    if (!parsed.ok) throw profileErrors.invalidItem(parsed.error);
    // A new `permission.skill` object REPLACES (not merges with) an action string the
    // same key gets from another file or the legacy `tools.skill`: carry that one as `"*"`.
    const fresh = (rule: "deny" | "allow"): JsonObject =>
      inherited !== undefined ? { "*": inherited, [name]: rule } : { [name]: rule };
    const permission = parsed.value.permission;
    if (permission === undefined) {
      return action === undefined ? text : setJsonc(text, ["permission", "skill"], fresh(action));
    }
    if (typeof permission === "string") {
      if (action === undefined) return text;
      return setJsonc(text, ["permission"], { "*": permission, skill: fresh(action) });
    }
    if (!isJsonObject(permission)) {
      throw profileErrors.invalidItem('"permission" in the config is neither an action nor a set of rules; fix it by hand first.');
    }
    const skill = permission.skill;
    if (skill === undefined) {
      return action === undefined ? text : setJsonc(text, ["permission", "skill"], fresh(action));
    }
    if (typeof skill === "string") {
      if (action === undefined) return text;
      return setJsonc(text, ["permission", "skill"], { "*": skill, [name]: action });
    }
    if (!isJsonObject(skill)) {
      throw profileErrors.invalidItem('"permission.skill" in the config is neither an action nor a set of rules; fix it by hand first.');
    }
    let next = text;
    if (Object.hasOwn(skill, name)) {
      next = setJsonc(next, ["permission", "skill", name], undefined);
    }
    if (action !== undefined) {
      return setJsonc(next, ["permission", "skill", name], action);
    }
    // Nothing left: drop the emptied `skill` rules, then an emptied `permission`.
    if (Object.keys(skill).every((key) => key === name)) {
      next = setJsonc(next, ["permission", "skill"], undefined);
      if (Object.keys(permission).every((key) => key === "skill")) {
        next = setJsonc(next, ["permission"], undefined);
      }
    }
    return next;
  }

  private async toggleSkill(model: Model, entry: Extract<Entry, { kind: "skill" }>, enabled: boolean): Promise<AdapterMutationResult> {
    this.requireConfig(model.config);
    const name = entry.skill.name;
    const allowedIn = (text: string): boolean => skillAllowed(mergedWithTarget(model.config, text), name);
    const blanket = permissionConfig(model.config.merged).skill;
    const inherited = typeof blanket === "string" ? blanket : undefined;
    let text: string;
    if (!enabled) {
      text = this.skillPermissionEdit(model.config.targetText, name, "deny", inherited);
      if (allowedIn(text)) {
        throw profileErrors.invalidItem(
          `A later permission rule in the config lets "${name}" through anyway; OpenCode applies the last matching rule. Move the skill rules after it by hand.`
        );
      }
    } else {
      text = this.skillPermissionEdit(model.config.targetText, name, undefined);
      if (!allowedIn(text)) {
        text = this.skillPermissionEdit(text, name, "allow", inherited);
      }
      if (!allowedIn(text)) {
        throw profileErrors.invalidItem(
          `A later permission rule in the config still denies "${name}"; OpenCode applies the last matching rule. Change it by hand.`
        );
      }
    }
    // The switch is for this skill alone: refuse an edit that would flip any other.
    const after = mergedWithTarget(model.config, text);
    const collateral = [...model.entries.values()].flatMap((other) =>
      other.kind === "skill" &&
      other.skill.named &&
      other.skill.name !== name &&
      skillAllowed(model.config.merged, other.skill.name) !== skillAllowed(after, other.skill.name)
        ? [other.skill.name]
        : []
    );
    if (collateral.length > 0) {
      throw profileErrors.invalidItem(
        `Turning "${name}" ${enabled ? "on" : "off"} here would also switch ${collateral.join(", ")}; change the permission rules by hand.`
      );
    }
    await this.writeConfig(model.config, text);
    return mutation([entry.item.id]);
  }

  private async stashItem(model: Model, entry: Entry): Promise<AdapterMutationResult> {
    const { item } = entry;
    const meta = item.description !== undefined ? { description: item.description } : undefined;
    if (entry.kind === "command" && entry.origin === "file") {
      await this.stash.stashPath(AGENT, "command", item.id, item.name, entry.command.file, meta);
      return mutation([item.id]);
    }
    if (entry.kind === "plugin" && entry.origin === "file") {
      await this.stash.stashPath(AGENT, "plugin", item.id, item.name, entry.file, meta);
      return mutation([item.id]);
    }
    this.requireConfig(model.config);
    let data: CommandFragment | PluginFragment;
    let text: string;
    if (entry.kind === "command" && entry.origin === "config") {
      if (entry.targetEntry === null) throw profileErrors.notToggleable(item.name);
      const keys = Object.keys(isJsonObject(model.config.targetValue?.command) ? model.config.targetValue.command : {});
      const at = keys.indexOf(entry.name);
      const raw = jsoncValueText(model.config.targetText, ["command", entry.name]);
      data = {
        origin: "config",
        name: entry.name,
        entry: entry.targetEntry,
        after: at > 0 ? keys[at - 1]! : null,
        ...(raw !== undefined ? { text: raw } : {})
      };
      text = setJsonc(model.config.targetText, ["command", entry.name], undefined);
    } else if (entry.kind === "plugin" && entry.origin === "config") {
      const list = Array.isArray(model.config.merged.plugin) ? model.config.merged.plugin : [];
      const previous = entry.index > 0 ? specOf(list[entry.index - 1]) : null;
      const raw = jsoncValueText(model.config.targetText, ["plugin", entry.index]);
      data = {
        origin: "config",
        entry: entry.raw,
        index: entry.index,
        after: previous === null ? null : pluginPackageKey(previous),
        ...(raw !== undefined ? { text: raw } : {})
      };
      text = setJsonc(model.config.targetText, ["plugin", entry.index], undefined);
    } else {
      throw profileErrors.notToggleable(item.name);
    }
    await this.stash.stashFragment(AGENT, entry.kind, item.id, item.name, data, meta);
    try {
      await this.writeConfig(model.config, text);
    } catch (error) {
      await this.stash.remove(AGENT, entry.kind, item.id).catch(() => undefined);
      throw error;
    }
    return mutation([item.id]);
  }

  private async restoreStashed(model: Model, entry: Extract<Entry, { origin: "stash" }>): Promise<AdapterMutationResult> {
    const { stash, item } = entry;
    if (stash.original.type === "path") {
      await this.stash.restorePath(AGENT, entry.kind, item.id);
      return mutation([item.id]);
    }
    this.requireConfig(model.config);
    const data = stash.original.data;
    if (!isJsonObject(data) || data.origin !== "config") {
      throw profileErrors.invalidItem(`The turned-off copy of "${item.name}" cannot be read.`);
    }
    let text = model.config.targetText;
    const target = model.config.targetValue ?? {};
    if (entry.kind === "command") {
      const fragment = data as unknown as CommandFragment;
      if (!isJsonObject(fragment.entry) || typeof fragment.name !== "string") {
        throw profileErrors.invalidItem(`The turned-off copy of "${item.name}" cannot be read.`);
      }
      if (isJsonObject(target.command) && fragment.name in target.command) {
        throw profileErrors.stashConflict(`command.${fragment.name} in ${model.config.targetPath}`);
      }
      const keys = Object.keys(isJsonObject(target.command) ? target.command : {});
      // Back after the key it followed (first when it was first; last when that key is gone).
      const at = fragment.after === null ? 0 : typeof fragment.after === "string" && keys.includes(fragment.after) ? keys.indexOf(fragment.after) + 1 : keys.length;
      text = insertJsoncMember(text, ["command"], fragment.name, at, fragment.entry, typeof fragment.text === "string" ? fragment.text : undefined);
    } else {
      const fragment = data as unknown as PluginFragment;
      const spec = specOf(fragment.entry);
      if (spec === null) throw profileErrors.invalidItem(`The turned-off copy of "${item.name}" cannot be read.`);
      if (!model.pluginListInTarget) {
        throw profileErrors.invalidItem(
          `The plugin list OpenCode uses is in another config file than ${model.config.targetName}; add the plugin there.`
        );
      }
      if (target.plugin !== undefined && !Array.isArray(target.plugin)) {
        throw profileErrors.unreadable(model.config.targetPath, '"plugin" is not a list');
      }
      const list = Array.isArray(target.plugin) ? target.plugin : [];
      const key = pluginPackageKey(spec);
      if (list.some((raw) => specOf(raw) !== null && pluginPackageKey(specOf(raw)!) === key)) {
        throw profileErrors.stashConflict(`"${key}" in the plugin list of ${model.config.targetPath}`);
      }
      // Back after the entry it followed, so turning several off and on keeps their order.
      const previous =
        typeof fragment.after === "string"
          ? list.findIndex((raw) => specOf(raw) !== null && pluginPackageKey(specOf(raw)!) === fragment.after)
          : -1;
      const index =
        fragment.after === null
          ? 0
          : previous >= 0
            ? previous + 1
            : Math.min(Math.max(0, typeof fragment.index === "number" ? fragment.index : list.length), list.length);
      text = Array.isArray(target.plugin)
        ? insertJsoncArrayItem(text, ["plugin"], index, fragment.entry, typeof fragment.text === "string" ? fragment.text : undefined)
        : setJsonc(text, ["plugin"], [fragment.entry]);
    }
    await this.writeConfig(model.config, text);
    await this.stash.remove(AGENT, entry.kind, item.id);
    return mutation([item.id]);
  }

  async remove(id: string, revision: string): Promise<AdapterMutationResult> {
    const model = await this.load();
    const entry = this.checked(model, id, revision);
    if (!entry.item.deletable) {
      throw profileErrors.notDeletable(entry.item.name);
    }
    const write = { backups: this.backups, agent: AGENT };
    switch (entry.kind) {
      case "mcp":
        this.requireConfig(model.config);
        await this.writeConfig(model.config, setJsonc(model.config.targetText, ["mcp", entry.name], undefined));
        return mutation([id]);
      case "skill": {
        await removeProfilePath(entry.skill.dir, write);
        // A stale `deny` would silently turn off a later skill of the same name.
        const skillRules = model.config.targetValue?.permission;
        if (
          !model.config.broken &&
          isJsonObject(skillRules) &&
          isJsonObject(skillRules.skill) &&
          Object.hasOwn(skillRules.skill, entry.skill.name)
        ) {
          await this.writeConfig(model.config, this.skillPermissionEdit(model.config.targetText, entry.skill.name, undefined));
        }
        return mutation([id]);
      }
      case "command":
      case "plugin":
        if (entry.origin === "stash") {
          await this.stash.remove(AGENT, entry.kind, id);
          return { itemIds: [id], notes: [] };
        }
        if (entry.kind === "command" && entry.origin === "file") {
          await removeProfilePath(entry.command.file, write);
          return mutation([id]);
        }
        if (entry.kind === "plugin" && entry.origin === "file") {
          await removeProfilePath(entry.file, write);
          return mutation([id]);
        }
        this.requireConfig(model.config);
        if (entry.kind === "command" && entry.origin === "config") {
          await this.writeConfig(model.config, setJsonc(model.config.targetText, ["command", entry.name], undefined));
          return mutation([id]);
        }
        if (entry.kind === "plugin" && entry.origin === "config") {
          await this.writeConfig(model.config, setJsonc(model.config.targetText, ["plugin", entry.index], undefined));
          return mutation([id]);
        }
        throw profileErrors.notDeletable(id);
    }
  }

  async writeInstructions(text: string, revision: string): Promise<AdapterMutationResult> {
    if (typeof text !== "string") {
      throw profileErrors.invalid("The instructions must be text.");
    }
    const { info } = await this.instructionsInfo();
    if (info.revision !== revision) {
      throw profileErrors.conflict("AGENTS.md changed on disk since you opened it.");
    }
    await writeProfileFile(this.instructionsPath, text, { backups: this.backups, agent: AGENT });
    return { itemIds: [], notes: [OPENCODE_RECYCLE_NOTE] };
  }

  // -------------------------------------------------------------------------
  // Copy between agents
  // -------------------------------------------------------------------------

  async exportItem(id: string): Promise<PortableItem> {
    const model = await this.load();
    const entry = this.find(model, id);
    switch (entry.kind) {
      case "mcp":
        if (mcpEntryType(entry.effective) === null) {
          throw profileErrors.invalidItem(`"${entry.name}" is only an on/off override; there is no server to copy.`);
        }
        return { kind: "mcp", server: mcpPortable(entry.name, entry.effective) };
      case "skill": {
        if (entry.skill.error !== undefined) {
          throw profileErrors.invalidItem(`"${entry.skill.name}" cannot be read: ${entry.skill.error}`);
        }
        const parent = agentProfileImportsDir(this.ctx.appdir);
        await mkdir(parent, { recursive: true, mode: 0o700 });
        // The copy itself is the temp entry: the caller deletes `dir` and nothing is left behind.
        const dir = join(parent, `export-opencode-${randomUUID()}`);
        await copyTree(entry.skill.dir, dir, { refuseSymlinks: false });
        return { kind: "skill", name: entry.skill.name, dir };
      }
      case "command": {
        const document = await this.commandDocument(entry);
        return { kind: "command", name: entry.item.name, frontmatter: document.frontmatter, body: document.body };
      }
      default:
        throw profileErrors.invalidItem(`${LABEL} ${entry.kind} items cannot be copied to another agent.`);
    }
  }

  async importItem(item: PortableItem, options: { onConflict: ProfileConflictPolicy }): Promise<AdapterMutationResult> {
    const policy = options.onConflict ?? "fail";
    switch (item.kind) {
      case "mcp":
        assertMcpServerName(item.server.name);
        return this.createMcp({ name: item.server.name, transport: item.server.transport }, mcpEntryFromPortable(item.server), policy);
      case "command":
        return this.createCommand({ name: item.name, frontmatter: item.frontmatter, body: item.body }, policy);
      case "skill":
        return this.importSkill(item.name, item.dir, policy);
      default:
        throw profileErrors.kindNotSupported(LABEL, (item as { kind: string }).kind);
    }
  }

  private async importSkill(requested: string, source: string, policy: ProfileConflictPolicy): Promise<AdapterMutationResult> {
    assertSkillName(requested);
    const text = await readTextIfExists(join(source, SKILL_FILE));
    if (text === null) {
      throw profileErrors.importFailed(`"${requested}" has no ${SKILL_FILE}.`);
    }
    let doc: MarkdownDocument;
    try {
      // Written by another agent or the converter (YAML 1.2); rewritten below for OpenCode.
      doc = parseOpenCodeDocument(text, { yaml: undefined });
    } catch (error) {
      throw profileErrors.importFailed(`${SKILL_FILE} of "${requested}" cannot be read: ${message(error)}`);
    }
    this.checkSkillDescription(doc.frontmatter);
    const model = await this.load();
    const name = await this.claimSkillName(model, requested, policy);
    const copied = await copyTree(source, join(this.skillsRoot(), name), { refuseSymlinks: false });
    await writeSkill(this.skillsRoot(), { name, frontmatter: doc.frontmatter, body: doc.body }, {
      backups: this.backups,
      agent: AGENT,
      mergeExisting: false,
      yaml: "1.1"
    });
    const notes = copied.skipped.length > 0 ? [`Left out (symlinks and special files): ${copied.skipped.join(", ")}.`] : [];
    return mutation([itemId("skill", name)], [...notes, ...this.skillNotes(model.config, name)]);
  }
}
