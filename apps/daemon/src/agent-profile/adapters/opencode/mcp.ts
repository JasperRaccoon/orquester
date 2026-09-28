/**
 * OpenCode MCP entries (`mcp.<name>` in the config):
 *
 *   local:  {type: "local",  command: [cmd, ...args], environment?, cwd?, enabled?, timeout?}
 *   remote: {type: "remote", url, headers?, oauth?, enabled?, timeout?}
 *
 * Both are `additionalProperties: false` in OpenCode's schema — one unknown
 * key and the whole config fails to load — so only these keys are ever
 * written. An entry `{"enabled": false}` alone is an override for a server
 * defined elsewhere.
 *
 * `environment` and `headers` values are secrets: they never leave this
 * module in a view, only their keys.
 */

import type {
  McpServerDraft,
  McpServerView,
  SecretEntryDraft,
  SecretEntryView
} from "@orquester/api";
import { profileErrors } from "../../errors.ts";
import type { PortableMcpServer } from "../types.ts";
import { type JsonObject, isJsonObject } from "./jsonc.ts";

export type McpEntryType = "local" | "remote";

/** The entry's type when it is a definition; `null` for an override-only entry. */
export function mcpEntryType(entry: unknown): McpEntryType | null {
  if (!isJsonObject(entry)) return null;
  return entry.type === "local" || entry.type === "remote" ? entry.type : null;
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isJsonObject(value)) return out;
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === "string") out[key] = v;
  }
  return out;
}

function secretKeys(value: unknown): SecretEntryView[] | undefined {
  const keys = Object.keys(stringRecord(value));
  return keys.length > 0 ? keys.map((key) => ({ key, set: true as const })) : undefined;
}

/** The editor's view of an entry: secret values replaced by `{set: true}`. */
export function mcpView(name: string, entry: JsonObject): McpServerView {
  const type = mcpEntryType(entry);
  const advanced: Record<string, unknown> = {};
  if (typeof entry.timeout === "number") advanced.timeout = entry.timeout;
  const view: McpServerView = { name, transport: type === "remote" ? "http" : "stdio" };
  if (type === "local") {
    const command = Array.isArray(entry.command) ? entry.command.filter((part): part is string => typeof part === "string") : [];
    if (command.length > 0) view.command = command[0];
    if (command.length > 1) view.args = command.slice(1);
    if (typeof entry.cwd === "string") view.cwd = entry.cwd;
    const env = secretKeys(entry.environment);
    if (env) view.env = env;
  } else if (type === "remote") {
    if (typeof entry.url === "string") view.url = entry.url;
    const headers = secretKeys(entry.headers);
    if (headers) view.headers = headers;
  }
  if (Object.keys(advanced).length > 0) view.advanced = advanced;
  return view;
}

/** The portable form (real secret values) of a definition. */
export function mcpPortable(name: string, entry: JsonObject): PortableMcpServer {
  const type = mcpEntryType(entry);
  const server: PortableMcpServer = { name, transport: type === "remote" ? "http" : "stdio" };
  if (type === "local") {
    const command = Array.isArray(entry.command) ? entry.command.filter((part): part is string => typeof part === "string") : [];
    if (command.length > 0) server.command = command[0];
    if (command.length > 1) server.args = command.slice(1);
    if (typeof entry.cwd === "string") server.cwd = entry.cwd;
    const env = stringRecord(entry.environment);
    if (Object.keys(env).length > 0) server.env = env;
  } else {
    if (typeof entry.url === "string") server.url = entry.url;
    const headers = stringRecord(entry.headers);
    if (Object.keys(headers).length > 0) server.headers = headers;
  }
  if (typeof entry.timeout === "number") server.advanced = { timeout: entry.timeout };
  return server;
}

/** The label of the row's transport chip. */
export function mcpMeta(entry: JsonObject): Record<string, string> {
  const type = mcpEntryType(entry);
  if (type === "local") {
    const command = Array.isArray(entry.command) && typeof entry.command[0] === "string" ? entry.command[0] : "";
    return { transport: "stdio", ...(command ? { command } : {}) };
  }
  if (type === "remote") {
    return { transport: "http", ...(typeof entry.url === "string" ? { url: entry.url } : {}) };
  }
  return {};
}

/**
 * Resolves secret drafts against the values on disk: `{key, value}` sets,
 * `{key, keep: true}` keeps the current value (refused when there is none),
 * a key left out is removed.
 */
function resolveSecrets(
  label: string,
  drafts: readonly SecretEntryDraft[] | undefined,
  current: Record<string, string>
): Record<string, string> | undefined {
  if (drafts === undefined || drafts.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const draft of drafts) {
    if (!isJsonObject(draft) || typeof draft.key !== "string" || draft.key.trim().length === 0) {
      throw profileErrors.invalidItem(`Every ${label} entry needs a name.`);
    }
    const key = draft.key;
    if (key in out) {
      throw profileErrors.invalidItem(`${label} "${key}" is listed twice.`);
    }
    if ("keep" in draft && draft.keep === true) {
      if (!(key in current)) {
        throw profileErrors.invalidItem(`${label} "${key}" has no current value to keep; enter one.`);
      }
      out[key] = current[key]!;
    } else if ("value" in draft && typeof draft.value === "string") {
      out[key] = draft.value;
    } else {
      throw profileErrors.invalidItem(`${label} "${key}" needs a value.`);
    }
  }
  return out;
}

function positiveInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw profileErrors.invalidItem("Timeout must be a whole number of milliseconds above 0.");
  }
  return value;
}

/**
 * The entry a draft describes, built from OpenCode's known keys only.
 * `existing` (the entry on disk, for an update) supplies kept secrets and the
 * keys the editor does not show (`enabled`, a remote's `oauth`).
 */
export function mcpEntryFromDraft(draft: McpServerDraft, existing: JsonObject | null): JsonObject {
  if (draft.transport === "sse") {
    throw profileErrors.invalidItem("OpenCode has no SSE transport for MCP servers; use http (remote) instead.");
  }
  if (draft.transport !== "stdio" && draft.transport !== "http") {
    throw profileErrors.invalidItem(`Unknown transport "${String(draft.transport)}".`);
  }
  const advanced = isJsonObject(draft.advanced) ? draft.advanced : {};
  for (const key of Object.keys(advanced)) {
    if (key !== "timeout") {
      throw profileErrors.invalidItem(`OpenCode has no "${key}" setting for MCP servers.`);
    }
  }
  const timeout = advanced.timeout === undefined || advanced.timeout === null ? undefined : positiveInt(advanced.timeout);
  const sameType = existing !== null && mcpEntryType(existing) === (draft.transport === "stdio" ? "local" : "remote");
  const entry: JsonObject = {};
  if (draft.transport === "stdio") {
    const command = typeof draft.command === "string" ? draft.command.trim() : "";
    if (command.length === 0) {
      throw profileErrors.invalidItem("A local (stdio) MCP server needs a command.");
    }
    const args = draft.args ?? [];
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
      throw profileErrors.invalidItem("Arguments must be a list of strings.");
    }
    if (draft.url !== undefined && draft.url !== "") {
      throw profileErrors.invalidItem("A local (stdio) MCP server has no URL.");
    }
    if (draft.headers !== undefined && draft.headers.length > 0) {
      throw profileErrors.invalidItem("A local (stdio) MCP server has no headers; use environment variables.");
    }
    entry.type = "local";
    entry.command = [command, ...args];
    const env = resolveSecrets("Environment variable", draft.env, sameType ? stringRecord(existing?.environment) : {});
    if (env !== undefined) entry.environment = env;
    if (typeof draft.cwd === "string" && draft.cwd.trim().length > 0) entry.cwd = draft.cwd;
  } else {
    const url = typeof draft.url === "string" ? draft.url.trim() : "";
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      throw profileErrors.invalidItem("A remote (http) MCP server needs an http:// or https:// URL.");
    }
    if (draft.command !== undefined && draft.command !== "") {
      throw profileErrors.invalidItem("A remote (http) MCP server has no command.");
    }
    if (draft.env !== undefined && draft.env.length > 0) {
      throw profileErrors.invalidItem("A remote (http) MCP server has no environment variables; use headers.");
    }
    if (draft.cwd !== undefined && draft.cwd !== "") {
      throw profileErrors.invalidItem("A remote (http) MCP server has no working directory.");
    }
    entry.type = "remote";
    entry.url = url;
    const headers = resolveSecrets("Header", draft.headers, sameType ? stringRecord(existing?.headers) : {});
    if (headers !== undefined) entry.headers = headers;
    if (sameType && existing?.oauth !== undefined) entry.oauth = existing.oauth;
  }
  if (existing !== null && typeof existing.disabled === "boolean") {
    // The newer spelling of the switch; written back as the key this module owns.
    entry.enabled = !existing.disabled;
  } else if (existing !== null && typeof existing.enabled === "boolean") {
    entry.enabled = existing.enabled;
  }
  if (timeout !== undefined) entry.timeout = timeout;
  return entry;
}

/** The entry for a portable server (a copy from another agent): real values, known keys only. */
export function mcpEntryFromPortable(server: PortableMcpServer): JsonObject {
  const draft: McpServerDraft = {
    name: server.name,
    transport: server.transport,
    ...(server.command !== undefined ? { command: server.command } : {}),
    ...(server.args !== undefined ? { args: server.args } : {}),
    ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
    ...(server.url !== undefined ? { url: server.url } : {}),
    ...(server.env ? { env: Object.entries(server.env).map(([key, value]) => ({ key, value })) } : {}),
    ...(server.headers ? { headers: Object.entries(server.headers).map(([key, value]) => ({ key, value })) } : {}),
    ...(server.advanced?.timeout !== undefined ? { advanced: { timeout: server.advanced.timeout } } : {})
  };
  return mcpEntryFromDraft(draft, null);
}
