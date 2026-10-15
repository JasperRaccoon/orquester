/**
 * Agent host — the static chat catalog as the in-chat `orquester` server lists it (unified MCP
 * design 2026-10-15 §9.4): every `catalogFor("chat")` tool serialised ONCE through the MCP SDK's own
 * `tools/list` (a real client over an in-memory transport — exactly what a provider receives, and
 * what `mcp/catalog/registry.test.ts` measures the byte budgets on), keyed by name. A thread's
 * provider session advertises the subset its manifest names; a name the catalog no longer serves
 * falls back to the frozen legacy definitions (`legacy-definitions.ts`) an older daemon still runs.
 *
 * The catalog is loaded statically (pure modules only, `registry.test.ts`'s import-graph walk); no
 * handler ever runs here.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SESSION_TOOLS_SERVER_NAME } from "@orquester/api/agent-chat";

import type { AnyOrquesterTool } from "../../mcp/catalog/contract.ts";
import { catalogFor } from "../../mcp/catalog/index.ts";
import { LEGACY_SECRET_RESULT_KEYS, LEGACY_SESSION_TOOL_DEFINITIONS } from "./legacy-definitions.ts";

/** One tool as the host advertises it, and the result keys it masks. */
export interface AdvertisedTool {
  readonly entry: Tool;
  readonly secretResultKeys?: readonly string[];
}

/** The chat input shape (the executor's `audienceShape`: external-only keys stripped). */
export function chatShape(tool: AnyOrquesterTool): z.ZodRawShape {
  const stripped = new Set((tool.externalOnlyInput ?? []) as readonly string[]);
  return Object.fromEntries(Object.entries(tool.input as z.ZodRawShape).filter(([key]) => !stripped.has(key)));
}

/** The chat description (the executor's `audienceDescription`). */
export function chatDescription(tool: AnyOrquesterTool): string {
  return tool.chatNote ? `${tool.description} ${tool.chatNote}` : tool.description;
}

/** `tools/list` of `tools` through a real client, in order. */
export async function serializeChatTools(tools: readonly AnyOrquesterTool[]): Promise<Tool[]> {
  const server = new McpServer({ name: SESSION_TOOLS_SERVER_NAME, version: "catalog" });
  for (const tool of tools) {
    const shape = chatShape(tool);
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: chatDescription(tool),
        inputSchema: Object.keys(shape).length > 0 ? shape : z.object({}).strict(),
        annotations: tool.annotations
      },
      () => ({ content: [] })
    );
  }
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "orquester-host", version: "catalog" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

/** Every tool the host can advertise: the catalog's chat tools, then the legacy names it lacks. */
export interface ChatToolDefinitions {
  /** By name. */
  readonly byName: ReadonlyMap<string, AdvertisedTool>;
  /** The catalog's chat tools, in catalog order (the fallback set reads it). */
  readonly catalogNames: readonly string[];
  /** The frozen legacy names, in their old order. */
  readonly legacyNames: readonly string[];
}

/** Build the definitions from `tools` (the static catalog by default). */
export async function buildChatToolDefinitions(tools: readonly AnyOrquesterTool[] = catalogFor("chat")): Promise<ChatToolDefinitions> {
  const entries = await serializeChatTools(tools);
  const byName = new Map<string, AdvertisedTool>();
  tools.forEach((tool, index) => {
    const entry = entries[index]!;
    byName.set(tool.name, { entry, ...(tool.secretResultKeys ? { secretResultKeys: tool.secretResultKeys } : {}) });
  });
  for (const entry of LEGACY_SESSION_TOOL_DEFINITIONS) {
    if (byName.has(entry.name)) continue;
    const keys = LEGACY_SECRET_RESULT_KEYS[entry.name];
    byName.set(entry.name, { entry, ...(keys ? { secretResultKeys: keys } : {}) });
  }
  return { byName, catalogNames: tools.map((tool) => tool.name), legacyNames: LEGACY_SESSION_TOOL_DEFINITIONS.map((entry) => entry.name) };
}

/** Every name the host may ever advertise (static: the catalog's chat names and the legacy ones). */
export function knownSessionToolNames(tools: readonly AnyOrquesterTool[] = catalogFor("chat")): ReadonlySet<string> {
  return new Set([...tools.map((tool) => tool.name), ...LEGACY_SESSION_TOOL_DEFINITIONS.map((entry) => entry.name)]);
}
