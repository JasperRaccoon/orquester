/**
 * Box MCP bridge — what happens to each MCP server a box chat's CLI is
 * configured with (spec 2026-10-19 §8.4).
 *
 * - **Bridged** (the default for anything that must run, or reach, HERE): a
 *   stdio server — its command runs on the host, its secrets with it; an HTTP
 *   server on host loopback — the box cannot reach it; an HTTP server whose
 *   headers are secrets — they stay on the host. The box's config names
 *   `orq-agent mcp-bridge <serverId>` instead, under the SAME name, so the
 *   agent sees exactly the tools it sees on the host.
 * - **In box**: a server the owner switched to "Run in box". Its secrets reach
 *   the box in process env only (each CLI's adapter does that its own way).
 * - **Direct**: an internet HTTP server without secret headers, reached from
 *   the box as configured.
 *
 * Pure: the per-CLI readers turn each config shape into a {@link McpServerSpec}
 * and each adapter writes the plan back in its own format.
 */

import type { BoxSysInfo } from "@orquester/api";

import { newMcpBridgeServerId, type McpBridgeTarget } from "./mcp-bridge-registry.ts";

/** One MCP server, whatever CLI config it was read from. */
export interface McpServerSpec {
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpBridgedServer {
  name: string;
  serverId: string;
  target: McpBridgeTarget;
  /** What the box's config runs instead. */
  command: string;
  args: string[];
}

export interface McpBridgePlan {
  bridged: McpBridgedServer[];
  inBox: McpServerSpec[];
  direct: McpServerSpec[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    if (key.length > 0 && (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean")) {
      out[key] = String(entry);
    }
  }
  return out;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** True for a URL whose host is this machine's loopback (or the any-address). */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0.0.0.0" || /^127\./.test(host);
  } catch {
    return false;
  }
}

/** The argv a box config runs for a bridged server. */
export function mcpBridgeArgv(sys: Pick<BoxSysInfo, "agentPath">, serverId: string): { command: string; args: string[] } {
  return { command: sys.agentPath, args: ["mcp-bridge", serverId] };
}

/**
 * Plan every server. `runInBox` names the servers the owner switched to "Run in box"; a server
 * the box's config cannot express (a stdio server without a command) is left as it is.
 */
export function planMcpBridges(
  servers: readonly McpServerSpec[],
  input: { runInBox: ReadonlySet<string>; sys: Pick<BoxSysInfo, "agentPath"> }
): McpBridgePlan {
  const plan: McpBridgePlan = { bridged: [], inBox: [], direct: [] };
  for (const server of servers) {
    if (input.runInBox.has(server.name)) {
      plan.inBox.push(server);
      continue;
    }
    let target: McpBridgeTarget | null = null;
    if (server.transport === "stdio") {
      if (server.command !== undefined && server.command.length > 0) {
        target = {
          transport: "stdio",
          command: server.command,
          args: server.args ?? [],
          ...(server.cwd !== undefined && server.cwd.length > 0 ? { cwd: server.cwd } : {}),
          env: server.env ?? {}
        };
      }
    } else if (server.url !== undefined && /^https?:\/\//i.test(server.url)) {
      const headers = server.headers ?? {};
      if (isLoopbackUrl(server.url) || Object.keys(headers).length > 0) {
        target = { transport: server.transport, url: server.url, headers };
      }
    }
    if (target === null) {
      plan.direct.push(server);
      continue;
    }
    const serverId = newMcpBridgeServerId();
    const argv = mcpBridgeArgv(input.sys, serverId);
    plan.bridged.push({ name: server.name, serverId, target, command: argv.command, args: argv.args });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Readers: each CLI's config shape → McpServerSpec
// ---------------------------------------------------------------------------

/** A Claude `mcpServers` entry (`.claude.json`, `.mcp.json`, `--mcp-config`). */
export function claudeMcpSpec(name: string, def: unknown): McpServerSpec | null {
  if (!isRecord(def)) return null;
  const type = typeof def.type === "string" ? def.type : undefined;
  if (type === "sdk" || type === "claudeai-proxy" || type === "ws") return null;
  if (type === "http" || type === "sse" || (type === undefined && typeof def.url === "string")) {
    if (typeof def.url !== "string") return null;
    return { name, transport: type === "sse" ? "sse" : "http", url: def.url, headers: stringRecord(def.headers) };
  }
  if (typeof def.command !== "string") return null;
  return {
    name,
    transport: "stdio",
    command: def.command,
    args: stringList(def.args),
    env: stringRecord(def.env),
    ...(typeof def.cwd === "string" ? { cwd: def.cwd } : {})
  };
}

/**
 * A Codex / Grok `mcp_servers.<name>` table (`config.toml`, Codex's `config/read`). `env_vars` /
 * `bearer_token_env_var` name variables of the CLI's own environment, read from `processEnv`.
 */
export function tomlMcpSpec(name: string, entry: unknown, processEnv: Readonly<Record<string, string>> = {}): McpServerSpec | null {
  if (!isRecord(entry) || entry.enabled === false) return null;
  if (typeof entry.url === "string") {
    const headers = { ...stringRecord(entry.http_headers), ...stringRecord(entry.headers) };
    for (const [header, variable] of Object.entries(stringRecord(entry.env_http_headers))) {
      const value = processEnv[variable];
      if (value !== undefined) headers[header] = value;
    }
    if (typeof entry.bearer_token_env_var === "string") {
      const token = processEnv[entry.bearer_token_env_var];
      if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    }
    return { name, transport: entry.transport === "sse" ? "sse" : "http", url: entry.url, headers };
  }
  if (typeof entry.command !== "string") return null;
  const env = stringRecord(entry.env);
  for (const variable of stringList(entry.env_vars)) {
    const value = processEnv[variable];
    if (value !== undefined && env[variable] === undefined) env[variable] = value;
  }
  return {
    name,
    transport: "stdio",
    command: entry.command,
    args: stringList(entry.args),
    env,
    ...(typeof entry.cwd === "string" ? { cwd: entry.cwd } : {})
  };
}

/** An OpenCode `mcp.<name>` entry (`type: "local" | "remote"`). */
export function openCodeMcpSpec(name: string, entry: unknown): McpServerSpec | null {
  if (!isRecord(entry) || entry.enabled === false) return null;
  if (entry.type === "remote") {
    if (typeof entry.url !== "string") return null;
    return { name, transport: "http", url: entry.url, headers: stringRecord(entry.headers) };
  }
  const command = stringList(entry.command);
  if (entry.type !== "local" || command.length === 0) return null;
  return { name, transport: "stdio", command: command[0]!, args: command.slice(1), env: stringRecord(entry.environment) };
}
