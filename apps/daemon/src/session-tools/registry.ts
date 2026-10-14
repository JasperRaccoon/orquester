/**
 * Session tools — the registry built from a toolkit list, and the
 * instruction block composed from it (design §1.1, §1.4).
 *
 * Production builds it from `SESSION_TOOLKITS` (`index.ts`); tests build it
 * from their own list (`testing.ts`). An empty registry is `enabled: false`,
 * and then no provider is given an `orquester` server at all.
 */

import {
  SESSION_TOOL_NAME_PATTERN,
  SESSION_TOOLS_SERVER_NAME
} from "@orquester/api/agent-chat";

import type { SessionTool, SessionToolkit } from "./contract.ts";

const TOOLKIT_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * The whole instruction block's ceiling (§1.4, "under ~1.5 KB"). A
 * composition over it throws at registry build — a test over the production
 * list catches it before a deploy, and nothing is ever cut silently.
 */
export const SESSION_TOOL_INSTRUCTIONS_MAX_BYTES = 1536;

/** The block's opening paragraph, before each toolkit's own. */
const INSTRUCTIONS_HEADER = `## Orquester

You are running inside Orquester's agent chat. The \`${SESSION_TOOLS_SERVER_NAME}\` MCP server's tools act on this chat thread inside Orquester. Their names may carry a harness prefix (\`mcp__orquester__<tool>\`, \`orquester__<tool>\`, \`orquester-<id>_<tool>\`); they are the same tools. Each tool's description has its full rules.`;

/** Compose the block from each toolkit's paragraph; "" when no toolkit has a tool. */
export function composeSessionToolInstructions(toolkits: readonly SessionToolkit[]): string {
  const live = toolkits.filter((toolkit) => toolkit.tools.length > 0);
  if (live.length === 0) {
    return "";
  }
  const snippets = live
    .map((toolkit) => toolkit.instructions?.trim())
    .filter((snippet): snippet is string => snippet !== undefined && snippet.length > 0);
  return [INSTRUCTIONS_HEADER, ...snippets].join("\n\n");
}

export interface SessionToolRegistry {
  /** True when at least one tool is registered: the `orquester` server is attached only then. */
  readonly enabled: boolean;
  /** Every tool, in toolkit order. */
  readonly tools: readonly SessionTool[];
  /** The composed instruction block; "" when disabled. */
  readonly instructions: string;
  get(name: string): SessionTool | undefined;
}

/** Validate and index a toolkit list. Throws on a bad id, a bad or duplicate name, or an oversized block. */
export function createSessionToolRegistry(toolkits: readonly SessionToolkit[]): SessionToolRegistry {
  const byName = new Map<string, SessionTool>();
  const ids = new Set<string>();
  for (const toolkit of toolkits) {
    if (!TOOLKIT_ID_PATTERN.test(toolkit.id) || ids.has(toolkit.id)) {
      throw new Error(`session-tools: bad or duplicate toolkit id ${JSON.stringify(toolkit.id)}`);
    }
    ids.add(toolkit.id);
    for (const tool of toolkit.tools) {
      if (!SESSION_TOOL_NAME_PATTERN.test(tool.name)) {
        throw new Error(`session-tools: bad tool name ${JSON.stringify(tool.name)} in ${toolkit.id}`);
      }
      if (byName.has(tool.name)) {
        throw new Error(`session-tools: duplicate tool name ${tool.name} in ${toolkit.id}`);
      }
      byName.set(tool.name, tool);
    }
  }
  const instructions = composeSessionToolInstructions(toolkits);
  const size = Buffer.byteLength(instructions, "utf8");
  if (size > SESSION_TOOL_INSTRUCTIONS_MAX_BYTES) {
    throw new Error(
      `session-tools: the instruction block is ${size} bytes, over the ${SESSION_TOOL_INSTRUCTIONS_MAX_BYTES}-byte cap; move detail into tool descriptions`
    );
  }
  const tools = [...byName.values()];
  return {
    enabled: tools.length > 0,
    tools,
    instructions,
    get: (name) => byName.get(name)
  };
}
