/**
 * Codex MCP servers: `[mcp_servers.<name>]` in `config.toml` (spec §3, §4.6).
 *
 * - stdio: `command`, `args`, `env` (a table — secret values), `env_vars`
 *   (names forwarded from the parent env), `cwd`;
 * - streamable HTTP: `url`, `bearer_token_env_var`, `http_headers` (a table —
 *   secret values), `env_http_headers` (header → env var name);
 * - both: `enabled`, `required`, `startup_timeout_sec`, `tool_timeout_sec`,
 *   `enabled_tools`, `disabled_tools`, and more this module does not own.
 *
 * A transport's field on the other transport is a load error in Codex
 * ("url is not supported for stdio"), so switching transport drops the old
 * transport's fields. Every field this module does not own (`enabled`,
 * `env_vars`, `env_http_headers`, anything newer) survives an edit.
 * Secret values never leave this module except through {@link portableFromEntry}.
 */

import {
  MCP_ADVANCED_FIELDS,
  type McpServerDraft,
  type McpServerView,
  type SecretEntryDraft,
  type SecretEntryView
} from "@orquester/api";
import { profileErrors } from "../../errors.ts";
import { assertMcpServerName } from "../../infra/index.ts";
import type { PortableMcpServer } from "../types.ts";

export type CodexMcpEntry = Record<string, unknown>;

const STDIO_FIELDS = ["command", "args", "env", "env_vars", "cwd"] as const;
const HTTP_FIELDS = ["url", "bearer_token_env_var", "http_headers", "env_http_headers"] as const;
const ADVANCED_KEYS: readonly string[] = MCP_ADVANCED_FIELDS.codex.map((field) => field.key);
/** Advanced fields that belong to the HTTP transport only. */
const HTTP_ONLY_ADVANCED = new Set(["bearer_token_env_var"]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringTable(value: unknown): Record<string, string> {
  const table: Record<string, string> = {};
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === "string") {
        table[key] = entry;
      }
    }
  }
  return table;
}

function secretViews(value: unknown): SecretEntryView[] | undefined {
  const keys = Object.keys(stringTable(value));
  return keys.length > 0 ? keys.map((key) => ({ key, set: true as const })) : undefined;
}

export function mcpTransport(entry: CodexMcpEntry): "stdio" | "http" {
  return typeof entry.url === "string" ? "http" : "stdio";
}

/** Codex's own flag: absent means on. */
export function mcpEnabled(entry: CodexMcpEntry): boolean {
  return entry.enabled !== false;
}

function advancedOf(entry: CodexMcpEntry): Record<string, unknown> | undefined {
  const advanced: Record<string, unknown> = {};
  for (const key of ADVANCED_KEYS) {
    if (entry[key] !== undefined && entry[key] !== null) {
      advanced[key] = entry[key];
    }
  }
  return Object.keys(advanced).length > 0 ? advanced : undefined;
}

/** The editor's view: env and header VALUES replaced by `{key, set: true}`. */
export function mcpView(name: string, entry: CodexMcpEntry): McpServerView {
  const transport = mcpTransport(entry);
  const view: McpServerView = { name, transport };
  if (transport === "stdio") {
    if (typeof entry.command === "string") view.command = entry.command;
    if (Array.isArray(entry.args)) view.args = entry.args.filter((arg): arg is string => typeof arg === "string");
    if (typeof entry.cwd === "string") view.cwd = entry.cwd;
    const env = secretViews(entry.env);
    if (env !== undefined) view.env = env;
  } else {
    view.url = entry.url as string;
    const headers = secretViews(entry.http_headers);
    if (headers !== undefined) view.headers = headers;
  }
  const advanced = advancedOf(entry);
  if (advanced !== undefined) view.advanced = advanced;
  return view;
}

/** Every secret value an entry holds (for redacting error text). */
export function mcpSecretValues(entry: CodexMcpEntry | undefined): string[] {
  if (entry === undefined) return [];
  return [...Object.values(stringTable(entry.env)), ...Object.values(stringTable(entry.http_headers))].filter(
    (value) => value.length > 0
  );
}

function resolveSecrets(
  drafts: readonly SecretEntryDraft[] | undefined,
  current: Record<string, string>,
  what: "environment variable" | "header",
  validKey: (key: string) => boolean
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const draft of drafts ?? []) {
    if (!isRecord(draft) || typeof draft.key !== "string" || !validKey(draft.key)) {
      throw profileErrors.invalidItem(`${JSON.stringify((draft as { key?: unknown })?.key)} is not a valid ${what} name.`);
    }
    if (Object.hasOwn(out, draft.key)) {
      throw profileErrors.invalidItem(`The ${what} "${draft.key}" is listed twice.`);
    }
    if ("keep" in draft && draft.keep === true) {
      if (!Object.hasOwn(current, draft.key)) {
        throw profileErrors.invalidItem(`The ${what} "${draft.key}" has no saved value to keep.`);
      }
      out[draft.key] = current[draft.key];
    } else if ("value" in draft && typeof draft.value === "string") {
      if (draft.value.includes("\0")) {
        throw profileErrors.invalidItem(`The ${what} "${draft.key}" holds a NUL byte.`);
      }
      out[draft.key] = draft.value;
    } else {
      throw profileErrors.invalidItem(`The ${what} "${draft.key}" needs a value or "keep".`);
    }
  }
  return out;
}

function validAdvanced(key: string, value: unknown): boolean {
  const spec = MCP_ADVANCED_FIELDS.codex.find((field) => field.key === key);
  switch (spec?.type) {
    case "number":
      return typeof value === "number" && Number.isFinite(value) && value > 0;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string" && value.length > 0;
    case "string-list":
      return Array.isArray(value) && value.every((entry) => typeof entry === "string");
    default:
      return false;
  }
}

/**
 * The `[mcp_servers.<name>]` table a draft makes, built on `existing` (an
 * edit keeps every field it does not own). Validates everything first; an
 * env/header `keep` takes the value from `existing`. Codex has no SSE
 * transport.
 */
export function mcpEntryFromDraft(draft: McpServerDraft, existing: CodexMcpEntry | undefined): CodexMcpEntry {
  if (!isRecord(draft) || typeof draft.name !== "string") {
    throw profileErrors.invalidItem("An MCP server needs a name.");
  }
  assertMcpServerName(draft.name);
  if (draft.transport !== "stdio" && draft.transport !== "http") {
    throw profileErrors.invalidItem(
      draft.transport === "sse"
        ? "Codex has no SSE transport; use streamable HTTP."
        : `Unknown MCP transport ${JSON.stringify(draft.transport)}.`
    );
  }
  const entry: CodexMcpEntry = { ...(existing ?? {}) };
  for (const key of ADVANCED_KEYS) {
    delete entry[key];
  }
  if (draft.transport === "stdio") {
    const command = typeof draft.command === "string" ? draft.command.trim() : "";
    if (command.length === 0) {
      throw profileErrors.invalidItem("A stdio MCP server needs a command.");
    }
    if (draft.args !== undefined && (!Array.isArray(draft.args) || !draft.args.every((a) => typeof a === "string"))) {
      throw profileErrors.invalidItem("Arguments must be a list of strings.");
    }
    if (draft.cwd !== undefined && typeof draft.cwd !== "string") {
      throw profileErrors.invalidItem("The working directory must be a string.");
    }
    if (draft.headers !== undefined && draft.headers.length > 0) {
      throw profileErrors.invalidItem("Headers belong to an HTTP MCP server.");
    }
    const env = resolveSecrets(draft.env, stringTable(existing?.env), "environment variable", (key) => ENV_NAME.test(key));
    for (const key of HTTP_FIELDS) {
      delete entry[key];
    }
    entry.command = command;
    setOrDelete(entry, "args", draft.args !== undefined && draft.args.length > 0 ? [...draft.args] : undefined);
    setOrDelete(entry, "cwd", typeof draft.cwd === "string" && draft.cwd.trim().length > 0 ? draft.cwd : undefined);
    setOrDelete(entry, "env", Object.keys(env).length > 0 ? env : undefined);
  } else {
    const url = typeof draft.url === "string" ? draft.url.trim() : "";
    if (!/^https?:\/\/\S+$/i.test(url)) {
      throw profileErrors.invalidItem("An HTTP MCP server needs an http:// or https:// URL.");
    }
    if (draft.env !== undefined && draft.env.length > 0) {
      throw profileErrors.invalidItem("Environment variables belong to a stdio MCP server.");
    }
    const headers = resolveSecrets(
      draft.headers,
      stringTable(existing?.http_headers),
      "header",
      (key) => key.length > 0 && !/[\s:]/.test(key)
    );
    for (const key of STDIO_FIELDS) {
      delete entry[key];
    }
    entry.url = url;
    setOrDelete(entry, "http_headers", Object.keys(headers).length > 0 ? headers : undefined);
  }
  for (const [key, value] of Object.entries(draft.advanced ?? {})) {
    if (!ADVANCED_KEYS.includes(key) || value === null || value === undefined) {
      continue;
    }
    if (HTTP_ONLY_ADVANCED.has(key) && draft.transport !== "http") {
      continue;
    }
    if (!validAdvanced(key, value)) {
      throw profileErrors.invalidItem(`"${key}" has an invalid value.`);
    }
    entry[key] = Array.isArray(value) ? [...value] : value;
  }
  return entry;
}

function setOrDelete(entry: CodexMcpEntry, key: string, value: unknown): void {
  if (value === undefined) {
    delete entry[key];
  } else {
    entry[key] = value;
  }
}

/** The server with its real secret values, for a copy to another agent. */
export function portableFromEntry(name: string, entry: CodexMcpEntry): PortableMcpServer {
  const view = mcpView(name, entry);
  const server: PortableMcpServer = { name, transport: view.transport };
  if (view.command !== undefined) server.command = view.command;
  if (view.args !== undefined) server.args = view.args;
  if (view.cwd !== undefined) server.cwd = view.cwd;
  if (view.url !== undefined) server.url = view.url;
  const env = stringTable(entry.env);
  if (view.transport === "stdio" && Object.keys(env).length > 0) server.env = env;
  const headers = stringTable(entry.http_headers);
  if (view.transport === "http" && Object.keys(headers).length > 0) server.headers = headers;
  // Codex-only settings travel as advanced keys, so the converter names them
  // in its "Dropped MCP settings …" note instead of losing them silently.
  const advanced: Record<string, unknown> = { ...(view.advanced ?? {}) };
  for (const key of ["env_vars", "env_http_headers"] as const) {
    if (entry[key] !== undefined) advanced[key] = entry[key];
  }
  if (Object.keys(advanced).length > 0) server.advanced = advanced;
  return server;
}

/** A portable server (already converted for Codex) as a draft with real values. */
export function draftFromPortable(server: PortableMcpServer): McpServerDraft {
  return {
    name: server.name,
    transport: server.transport,
    ...(server.command !== undefined ? { command: server.command } : {}),
    ...(server.args !== undefined ? { args: server.args } : {}),
    ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
    ...(server.url !== undefined ? { url: server.url } : {}),
    ...(server.env !== undefined
      ? { env: Object.entries(server.env).map(([key, value]) => ({ key, value })) }
      : {}),
    ...(server.headers !== undefined
      ? { headers: Object.entries(server.headers).map(([key, value]) => ({ key, value })) }
      : {}),
    ...(server.advanced !== undefined ? { advanced: server.advanced } : {})
  };
}
