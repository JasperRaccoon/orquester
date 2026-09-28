/**
 * Claude MCP server definitions (`~/.claude.json` `mcpServers.<name>`) to and
 * from the wire's views and drafts.
 *
 * Shape (Claude 2.1.280): `{type?: "stdio" | "http" | "sse" | "streamable-http"
 * | …, command, args, env, url, headers, timeout?, …}`; a missing `type` with a
 * `command` is stdio, `streamable-http` is an alias of `http`. Keys this
 * module does not know (`oauth`, `headersHelper`, …) survive an edit.
 *
 * Secret values (`env`, `headers`) leave here only as keys ({@link SecretEntryView})
 * or, for a copy between agents, in a {@link PortableMcpServer} that never
 * reaches a client.
 */

import {
  MCP_TRANSPORTS,
  type McpServerDraft,
  type McpServerView,
  type McpTransport,
  type SecretEntryDraft,
  type SecretEntryView
} from "@orquester/api";
import { profileErrors } from "../../errors.ts";
import type { PortableMcpServer } from "../types.ts";
import { isRecord } from "./settings.ts";

/** The wire transport of a definition; `null` for a type the editor cannot represent (`ws`, `sdk`, …). */
export function mcpTransportOf(def: Record<string, unknown>): McpTransport | null {
  const type = def.type;
  if (type === undefined) {
    return typeof def.command === "string" ? "stdio" : typeof def.url === "string" ? "http" : null;
  }
  switch (type) {
    case "stdio":
      return "stdio";
    case "http":
    case "streamable-http":
      return "http";
    case "sse":
      return "sse";
    default:
      return null;
  }
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === "string") out[key] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[key] = String(v);
  }
  return out;
}

function secretKeys(value: unknown): SecretEntryView[] | undefined {
  if (!isRecord(value)) return undefined;
  return Object.keys(value).map((key) => ({ key, set: true as const }));
}

/** The editable view — values of `env` and `headers` replaced by `{set: true}`. */
export function mcpView(name: string, def: Record<string, unknown>): McpServerView {
  const transport = mcpTransportOf(def) ?? (typeof def.url === "string" ? "http" : "stdio");
  const view: McpServerView = { name, transport };
  if (typeof def.command === "string") view.command = def.command;
  if (Array.isArray(def.args)) view.args = def.args.map(String);
  if (typeof def.cwd === "string") view.cwd = def.cwd;
  const env = secretKeys(def.env);
  if (env !== undefined) view.env = env;
  if (typeof def.url === "string") view.url = def.url;
  const headers = secretKeys(def.headers);
  if (headers !== undefined) view.headers = headers;
  if (typeof def.timeout === "number") view.advanced = { timeout: def.timeout };
  return view;
}

/** A one-liner for the row: the command line or the URL. */
export function mcpTarget(def: Record<string, unknown>): string | undefined {
  if (typeof def.command === "string") {
    const args = Array.isArray(def.args) ? def.args.map(String) : [];
    return [def.command, ...args].join(" ");
  }
  return typeof def.url === "string" ? def.url : undefined;
}

export { SecretDigester } from "../../infra/secret-digest.ts";

/**
 * Resolves draft entries against the values on disk: `{key, value}` sets,
 * `{key, keep: true}` keeps the current value (400 when there is none), and a
 * key the draft leaves out is removed. The error never names a value.
 */
export function resolveSecretEntries(
  drafts: readonly SecretEntryDraft[] | undefined,
  existing: Record<string, string>,
  field: "env" | "headers"
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of drafts ?? []) {
    if (!isRecord(entry) || typeof entry.key !== "string" || entry.key.length === 0) {
      throw profileErrors.invalidItem(`Every ${field} entry needs a key.`);
    }
    if ("keep" in entry && entry.keep === true) {
      if (!(entry.key in existing)) {
        throw profileErrors.invalidItem(`${field} "${entry.key}" has no saved value to keep; enter one.`);
      }
      out[entry.key] = existing[entry.key]!;
    } else if ("value" in entry && typeof entry.value === "string") {
      out[entry.key] = entry.value;
    } else {
      throw profileErrors.invalidItem(`${field} "${entry.key}" needs a value.`);
    }
  }
  return out;
}

/** The non-secret draft checks: transport known to Claude, and a command or URL for it. */
function assertDraftShape(draft: { transport: McpTransport; command?: string; url?: string; args?: unknown }): void {
  if (!MCP_TRANSPORTS.claude.includes(draft.transport)) {
    throw profileErrors.invalidItem(`Claude does not support the "${String(draft.transport)}" transport.`);
  }
  if (draft.transport === "stdio") {
    if (typeof draft.command !== "string" || draft.command.trim().length === 0) {
      throw profileErrors.invalidItem("A stdio server needs a command.");
    }
    if (draft.args !== undefined && (!Array.isArray(draft.args) || draft.args.some((a) => typeof a !== "string"))) {
      throw profileErrors.invalidItem("Arguments must be a list of strings.");
    }
  } else if (typeof draft.url !== "string" || !/^https?:\/\//i.test(draft.url.trim())) {
    throw profileErrors.invalidItem("An http or sse server needs an http(s) URL.");
  }
}

/** The fields this module writes; everything else on an existing definition is kept. */
const OWNED_FIELDS = ["type", "command", "args", "env", "cwd", "url", "headers", "timeout"] as const;

/**
 * The definition to write for a draft whose secrets are already resolved to
 * real values. `existing` (an edit) keeps its unknown keys and, when the
 * transport did not change, its own `type` spelling (`streamable-http`).
 */
export function buildMcpDefinition(
  draft: {
    transport: McpTransport;
    command?: string;
    args?: string[];
    cwd?: string;
    url?: string;
    advanced?: Record<string, unknown>;
  },
  env: Record<string, string>,
  headers: Record<string, string>,
  existing?: Record<string, unknown>
): Record<string, unknown> {
  assertDraftShape(draft);
  const def: Record<string, unknown> = { ...(existing ?? {}) };
  for (const field of OWNED_FIELDS) delete def[field];
  const keepType = existing !== undefined && mcpTransportOf(existing) === draft.transport && typeof existing.type === "string";
  const out: Record<string, unknown> = { type: keepType ? existing!.type : draft.transport };
  if (draft.transport === "stdio") {
    out.command = draft.command!.trim();
    out.args = draft.args ?? [];
    out.env = env;
    if (typeof draft.cwd === "string" && draft.cwd.length > 0) out.cwd = draft.cwd;
  } else {
    out.url = draft.url!.trim();
    if (Object.keys(headers).length > 0) out.headers = headers;
  }
  const timeout = draft.advanced?.timeout;
  if (timeout !== undefined && timeout !== null && timeout !== "") {
    const ms = Number(timeout);
    if (!Number.isFinite(ms) || ms <= 0) {
      throw profileErrors.invalidItem("Timeout must be a positive number of milliseconds.");
    }
    out.timeout = Math.round(ms);
  }
  return { ...out, ...def };
}

/** The draft's definition, secrets resolved against `existing` (or nothing, for a create). */
export function definitionFromDraft(draft: McpServerDraft, existing?: Record<string, unknown>): Record<string, unknown> {
  const env = draft.transport === "stdio" ? resolveSecretEntries(draft.env, stringMap(existing?.env), "env") : {};
  const headers = draft.transport === "stdio" ? {} : resolveSecretEntries(draft.headers, stringMap(existing?.headers), "headers");
  return buildMcpDefinition(draft, env, headers, existing);
}

/** A definition lifted out for another agent — real secret values included. */
export function portableFromDefinition(name: string, def: Record<string, unknown>): PortableMcpServer {
  const server: PortableMcpServer = { name, transport: mcpTransportOf(def) ?? "stdio" };
  if (typeof def.command === "string") server.command = def.command;
  if (Array.isArray(def.args)) server.args = def.args.map(String);
  if (typeof def.cwd === "string") server.cwd = def.cwd;
  const env = stringMap(def.env);
  if (Object.keys(env).length > 0) server.env = env;
  if (typeof def.url === "string") server.url = def.url;
  const headers = stringMap(def.headers);
  if (Object.keys(headers).length > 0) server.headers = headers;
  if (typeof def.timeout === "number") server.advanced = { timeout: def.timeout };
  return server;
}

/** A portable server as a Claude definition. */
export function definitionFromPortable(server: PortableMcpServer): Record<string, unknown> {
  return buildMcpDefinition(server, server.env ?? {}, server.headers ?? {});
}
