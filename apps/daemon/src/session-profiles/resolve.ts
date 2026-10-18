/**
 * Agent Profiles — what one agent gets from a profile (spec §4.1, §4.2): the input every
 * per-agent preparer consumes ({@link ResolvedAgentProfile}).
 *
 * Pure: `store.readSource(profileId)` does the reading (and holds the secret values);
 * {@link resolveForAgent} only filters and shapes. An item is in the result when it is enabled,
 * readable, its scope includes the agent, and the agent can express it. An enabled, in-scope item
 * that cannot be used is listed in `skipped` with the reason — never silently dropped, and it
 * never blocks the other items or agents.
 *
 * Commands are NOT converted here: Codex ships them as skills, and that is the Codex preparer's
 * job (spec §4.1).
 *
 * The result carries REAL secret values (MCP env/headers): never log it, never return it from a
 * route, never put it in argv.
 */

import {
  MCP_TRANSPORTS,
  PROFILE_HOOK_EVENTS,
  SESSION_PROFILE_AGENTS,
  SESSION_PROFILE_DEFAULT_SETTINGS,
  isSessionProfileAgentId,
  sessionProfileScopeProblem,
  type McpTransport,
  type SessionProfileAgentId,
  type SessionProfileAgentScope,
  type SessionProfileSettings
} from "@orquester/api";
import type {
  SessionProfileItemEntry,
  SessionProfileItemRecord,
  SessionProfileItemSecrets,
  SessionProfileSettingsRecord
} from "@orquester/config";
import { profileLayout } from "./layout.ts";

/** A profile as `store.readSource` reads it for resolving — WITH secret values. */
export interface SessionProfileSource {
  profileId: string;
  revision: string;
  name: string;
  /** The profile's source directory (see `layout.ts`). */
  dir: string;
  settings: SessionProfileSettingsRecord;
  /** `""` when the profile has none. */
  instructions: string;
  items: SessionProfileItemEntry[];
  /** By item id. */
  secrets: Record<string, SessionProfileItemSecrets>;
  /** Items whose content is not on disk: a skill without `SKILL.md`, a command file, an empty plugin cache. */
  missingContent: ReadonlySet<string>;
}

export interface ResolvedSkill {
  id: string;
  name: string;
  description?: string;
  /** The skill's source directory: copy its contents to `<target>/<name>/`. */
  dir: string;
  skillFile: string;
}

export interface ResolvedCommand {
  id: string;
  /** `review`, or `git/pr` (one folder level). */
  name: string;
  description?: string;
  /** The command's markdown (frontmatter + body). */
  file: string;
}

export interface ResolvedMcpServer {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  /** REAL values. */
  env: Record<string, string>;
  url?: string;
  /** REAL values. */
  headers: Record<string, string>;
  /** Per-agent, non-secret extras as the editor stored them (`MCP_ADVANCED_FIELDS`); map what the agent knows. */
  advanced: Record<string, unknown>;
}

export interface ResolvedHook {
  id: string;
  name: string;
  event: string;
  matcher?: string;
  command: string;
  timeoutSec?: number;
}

export interface ResolvedPlugin {
  id: string;
  name: string;
  marketplace?: string;
  version?: string;
  /** The plugin's files in the profile's own cache. */
  cacheDir: string;
}

export interface ResolvedSkippedItem {
  itemId?: string;
  kind?: string;
  name?: string;
  reason: string;
}

export interface ResolvedAgentProfile {
  profileId: string;
  revision: string;
  name: string;
  agent: SessionProfileAgentId;
  settings: { hideBuiltinSkills: boolean; claudeWorkflowTool: boolean };
  /** `""` when the profile has none. */
  instructions: string;
  skills: ResolvedSkill[];
  commands: ResolvedCommand[];
  mcpServers: ResolvedMcpServer[];
  hooks: ResolvedHook[];
  plugins: ResolvedPlugin[];
  /** Enabled, in-scope items left out for this agent, and why. */
  skipped: ResolvedSkippedItem[];
}

/**
 * The profile's settings with every default filled in (spec §4.3). The record keeps values raw
 * (a newer build's shape survives a rewrite); one that does not read is the default here.
 */
export function resolveSessionProfileSettings(record: SessionProfileSettingsRecord | undefined): SessionProfileSettings {
  const hide = { ...SESSION_PROFILE_DEFAULT_SETTINGS.hideBuiltinSkills };
  const perAgent = record?.hideBuiltinSkills;
  for (const agent of SESSION_PROFILE_AGENTS) {
    const value = typeof perAgent === "object" && perAgent !== null ? (perAgent as Record<string, unknown>)[agent] : undefined;
    if (typeof value === "boolean") hide[agent] = value;
  }
  const workflow = record?.claudeWorkflowTool;
  return {
    hideBuiltinSkills: hide,
    claudeWorkflowTool: typeof workflow === "boolean" ? workflow : SESSION_PROFILE_DEFAULT_SETTINGS.claudeWorkflowTool
  };
}

/**
 * A stored scope as the wire shows it: unknown agent ids (a newer build's) are left out. `null`
 * when nothing known is left — the item applies to no agent this build has.
 */
export function wireScope(scope: SessionProfileItemRecord["agents"]): SessionProfileAgentScope | null {
  if (scope === "all") return "all";
  const known = scope.filter(isSessionProfileAgentId);
  return known.length > 0 ? known : null;
}

/**
 * Why `agent` cannot load `record` even though it is in scope, or `null` when it can: an invalid
 * scope for the kind (a hook or plugin for "all"), an MCP transport the agent lacks, a hook event
 * the agent does not fire.
 */
export function itemUnsupportedReason(record: SessionProfileItemRecord, agent: SessionProfileAgentId): string | null {
  // Judged on the agents this build knows: a newer build's agent id in the list is ignored.
  const scopeProblem = sessionProfileScopeProblem(record.kind, wireScope(record.agents));
  if (scopeProblem !== null) return scopeProblem;
  if (record.kind === "mcp" && !MCP_TRANSPORTS[agent].includes(record.mcp.transport)) {
    return `${agentLabel(agent)} has no ${record.mcp.transport} MCP transport.`;
  }
  if (record.kind === "hook" && !(PROFILE_HOOK_EVENTS[agent] ?? []).includes(record.hook.event)) {
    return `${agentLabel(agent)} has no "${record.hook.event}" hook event.`;
  }
  return null;
}

function agentLabel(agent: SessionProfileAgentId): string {
  return agent === "opencode" ? "OpenCode" : agent.charAt(0).toUpperCase() + agent.slice(1);
}

function inScope(record: SessionProfileItemRecord, agent: SessionProfileAgentId): boolean {
  return record.agents === "all" || record.agents.includes(agent);
}

/** Picks `keys` out of `values`; `null` (with the first missing key) when one has no value. */
function pickSecrets(keys: string[] | undefined, values: Record<string, string> | undefined): Record<string, string> | { missing: string } {
  const out: Record<string, string> = {};
  for (const key of keys ?? []) {
    const value = values?.[key];
    if (typeof value !== "string") return { missing: key };
    out[key] = value;
  }
  return out;
}

/** {@link ResolvedAgentProfile} of `source` for `agent` (see the module header). */
export function resolveForAgent(source: SessionProfileSource, agent: SessionProfileAgentId): ResolvedAgentProfile {
  const layout = profileLayout(source.dir);
  const settings = resolveSessionProfileSettings(source.settings);
  const resolved: ResolvedAgentProfile = {
    profileId: source.profileId,
    revision: source.revision,
    name: source.name,
    agent,
    settings: { hideBuiltinSkills: settings.hideBuiltinSkills[agent], claudeWorkflowTool: settings.claudeWorkflowTool },
    instructions: source.instructions,
    skills: [],
    commands: [],
    mcpServers: [],
    hooks: [],
    plugins: [],
    skipped: []
  };

  for (const entry of source.items) {
    if (!entry.ok) {
      resolved.skipped.push({ ...(entry.id ? { itemId: entry.id } : {}), reason: `The item could not be read: ${entry.error}` });
      continue;
    }
    const record = entry.record;
    if (!record.enabled || !inScope(record, agent)) continue;
    const skip = (reason: string) => resolved.skipped.push({ itemId: record.id, kind: record.kind, name: record.name, reason });
    const unsupported = itemUnsupportedReason(record, agent);
    if (unsupported !== null) {
      skip(unsupported);
      continue;
    }
    if (source.missingContent.has(record.id)) {
      skip(record.kind === "plugin" ? "Its files are not in the profile's plugin cache." : "Its file is missing from the profile.");
      continue;
    }
    const description = record.description ? { description: record.description } : {};
    switch (record.kind) {
      case "skill":
        resolved.skills.push({
          id: record.id,
          name: record.name,
          ...description,
          dir: layout.skillDir(record.id),
          skillFile: layout.skillFile(record.id)
        });
        break;
      case "command":
        resolved.commands.push({ id: record.id, name: record.name, ...description, file: layout.commandFile(record.id) });
        break;
      case "mcp": {
        const secrets = source.secrets[record.id];
        const env = pickSecrets(record.mcp.envKeys, secrets?.env);
        const headers = pickSecrets(record.mcp.headerKeys, secrets?.headers);
        const missing = "missing" in env ? env.missing : "missing" in headers ? headers.missing : null;
        if (missing !== null) {
          skip(`The value of ${missing} is missing; enter it again.`);
          break;
        }
        const { mcp } = record;
        resolved.mcpServers.push({
          id: record.id,
          name: record.name,
          transport: mcp.transport,
          ...(mcp.command !== undefined ? { command: mcp.command } : {}),
          ...(mcp.args !== undefined ? { args: [...mcp.args] } : {}),
          ...(mcp.cwd !== undefined ? { cwd: mcp.cwd } : {}),
          env: env as Record<string, string>,
          ...(mcp.url !== undefined ? { url: mcp.url } : {}),
          headers: headers as Record<string, string>,
          advanced: { ...(mcp.advanced ?? {}) }
        });
        break;
      }
      case "hook":
        resolved.hooks.push({
          id: record.id,
          name: record.name,
          event: record.hook.event,
          ...(record.hook.matcher !== undefined ? { matcher: record.hook.matcher } : {}),
          command: record.hook.command,
          ...(record.hook.timeoutSec !== undefined ? { timeoutSec: record.hook.timeoutSec } : {})
        });
        break;
      case "plugin":
        resolved.plugins.push({
          id: record.id,
          name: record.name,
          ...(record.plugin.marketplace !== undefined ? { marketplace: record.plugin.marketplace } : {}),
          ...(record.plugin.version !== undefined ? { version: record.plugin.version } : {}),
          cacheDir: layout.pluginCacheDir(record.id)
        });
        break;
    }
  }
  return resolved;
}
