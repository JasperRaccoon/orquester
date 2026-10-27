/**
 * Box MCP bridge — the per-box registry of bridged servers (spec 2026-10-19
 * §8.4), shared by its two halves:
 *
 * - the AGENT HOST writes one entry per bridged server at a box launch: the
 *   server's real definition — command, args, cwd, env, or a URL and headers —
 *   with its secrets resolved ON THIS MACHINE; the box's CLI config names only
 *   `orq-agent mcp-bridge <serverId>`;
 * - the DAEMON's `mcp-bridge` channel handler (`boxes/remote/mcp-bridge.ts`)
 *   reads the entry the box's `orq-agent` names and runs the real server here.
 *
 * Files, not memory: the entry outlives a daemon restart (the box's CLI keeps
 * running and its bridge reconnects), and the two halves are two processes.
 * `<appdir>/daemon/boxes/mcp-bridge/<boxId>/<serverId>.json`, the directories
 * 0700 and each entry 0600, written atomically. A box can only ever name the
 * entries of its own directory, and a `serverId` is 24 random bytes.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { boxesDir } from "@orquester/config";

export const MCP_BRIDGE_ENTRY_VERSION = 1;

/** A stdio server run on this machine, its stdio piped to the box. */
export interface McpBridgeStdioTarget {
  transport: "stdio";
  command: string;
  args: string[];
  /** Host path. Absent: the daemon user's home. */
  cwd?: string;
  /** The server's own env (secrets resolved here); layered over a minimal host env. */
  env: Record<string, string>;
}

/** An HTTP MCP server reached from this machine (a loopback one, or one whose headers are secrets). */
export interface McpBridgeHttpTarget {
  transport: "http" | "sse";
  url: string;
  headers: Record<string, string>;
}

export type McpBridgeTarget = McpBridgeStdioTarget | McpBridgeHttpTarget;

export interface McpBridgeEntry {
  version: typeof MCP_BRIDGE_ENTRY_VERSION;
  boxId: string;
  serverId: string;
  /** The server's config name, for logs and the bridge's own errors. */
  name: string;
  /** The chat that registered it (its launch removes it at the session's end). */
  threadId: string;
  target: McpBridgeTarget;
  createdAt: string;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export function isMcpBridgeId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/** A fresh, unguessable server id. */
export function newMcpBridgeServerId(): string {
  return randomBytes(24).toString("base64url");
}

export function mcpBridgeBoxDir(appdir: string, boxId: string): string {
  // One path segment, never `.`/`..`: a box id names a directory.
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(boxId) || /^\.+$/.test(boxId)) {
    throw new Error("Not a box id.");
  }
  return join(boxesDir(appdir), "mcp-bridge", boxId);
}

function entryPath(appdir: string, boxId: string, serverId: string): string {
  if (!isMcpBridgeId(serverId)) throw new Error("Not an MCP bridge server id.");
  return join(mcpBridgeBoxDir(appdir, boxId), `${serverId}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    if (key.length > 0 && typeof entry === "string") out[key] = entry;
  }
  return out;
}

/** An entry read back from disk, field-wise; null for anything else. */
export function parseMcpBridgeEntry(value: unknown): McpBridgeEntry | null {
  if (!isRecord(value) || value.version !== MCP_BRIDGE_ENTRY_VERSION) return null;
  if (typeof value.boxId !== "string" || !isMcpBridgeId(value.serverId)) return null;
  if (typeof value.name !== "string" || typeof value.threadId !== "string") return null;
  const target = value.target;
  if (!isRecord(target)) return null;
  let parsed: McpBridgeTarget;
  if (target.transport === "stdio") {
    if (typeof target.command !== "string" || target.command.length === 0) return null;
    parsed = {
      transport: "stdio",
      command: target.command,
      args: Array.isArray(target.args) ? target.args.filter((arg): arg is string => typeof arg === "string") : [],
      ...(typeof target.cwd === "string" && target.cwd.length > 0 ? { cwd: target.cwd } : {}),
      env: stringRecord(target.env)
    };
  } else if (target.transport === "http" || target.transport === "sse") {
    if (typeof target.url !== "string" || !/^https?:\/\//i.test(target.url)) return null;
    parsed = { transport: target.transport, url: target.url, headers: stringRecord(target.headers) };
  } else {
    return null;
  }
  return {
    version: MCP_BRIDGE_ENTRY_VERSION,
    boxId: value.boxId,
    serverId: value.serverId,
    name: value.name,
    threadId: value.threadId,
    target: parsed,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : ""
  };
}

/** Write one entry (0600, atomic, in a 0700 directory). */
export async function writeMcpBridgeEntry(appdir: string, entry: McpBridgeEntry): Promise<void> {
  const dir = mcpBridgeBoxDir(appdir, entry.boxId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = entryPath(appdir, entry.boxId, entry.serverId);
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(entry), { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

/** The entry a box names, or null (unknown id, another box's, unreadable). */
export async function readMcpBridgeEntry(appdir: string, boxId: string, serverId: string): Promise<McpBridgeEntry | null> {
  if (!isMcpBridgeId(serverId)) return null;
  try {
    const entry = parseMcpBridgeEntry(JSON.parse(await readFile(entryPath(appdir, boxId, serverId), "utf8")) as unknown);
    return entry !== null && entry.boxId === boxId && entry.serverId === serverId ? entry : null;
  } catch {
    return null;
  }
}

/** Remove entries (a launch's own, at its session's end). Missing ones are fine. */
export async function removeMcpBridgeEntries(appdir: string, boxId: string, serverIds: readonly string[]): Promise<void> {
  await Promise.all(
    serverIds.filter(isMcpBridgeId).map((serverId) => rm(entryPath(appdir, boxId, serverId), { force: true }).catch(() => undefined))
  );
}
