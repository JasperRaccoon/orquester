/**
 * The Orquester tool catalog (unified MCP design 2026-10-15 §3.1, §4): every tool defined once,
 * in catalog order — one import per family module, written once by Task 2 and never edited by the
 * family tasks (plan "Shared files"). The external `/mcp` server is generated from
 * `catalogFor("external")`, the in-chat `orquester` server from `catalogFor("chat")`; the executor
 * (`../executor.ts`) is the only caller of a tool's `run`.
 *
 * The agent host loads this module statically: everything reachable from it must be pure (types,
 * zod, `@orquester/*` contracts, the `DaemonApi`-only tool helpers) — `registry.test.ts` walks the
 * import graph against an allow-list.
 */

import { agentProfileFamily } from "../tools/agent-profile.ts";
// boxes: temporary boxes for agent chats (Ephemeral AI VMs spec §13).
import { boxesFamily } from "../tools/boxes.ts";
import { catalogFamily } from "../tools/catalog.ts";
import { desktopsFamily } from "../tools/desktops.ts";
import { filesFamily } from "../tools/files.ts";
import { gitFamily } from "../tools/git.ts";
// Knowledge Graph plugin: the shared knowledge base for agent chats (its spec, "Agent tools").
import { knowledgeFamily } from "../tools/knowledge.ts";
import { lineageFamily } from "../tools/lineage.ts";
import { messagesFamily } from "../tools/messages.ts";
import { notifyFamily } from "../tools/notify.ts";
import { outputFamily } from "../tools/output.ts";
import { requestsFamily } from "../tools/requests.ts";
import { savedPromptsFamily } from "../tools/saved-prompts.ts";
import { searchFamily } from "../tools/search.ts";
import { secretFilesFamily } from "../tools/secret-files.ts";
import { secretsFamily } from "../tools/secrets.ts";
import { sessionsFamily } from "../tools/sessions.ts";
import { todosFamily } from "../tools/todos.ts";
import { usageFamily } from "../tools/usage.ts";
import { visualsFamily } from "../tools/visuals.ts";
import { watchFamily } from "../tools/watch.ts";
import { workflowsFamily } from "../tools/workflows.ts";
import type { AnyOrquesterTool, Audience } from "./contract.ts";

/** `^[a-z][a-z0-9_]{0,47}$` (spec §4.3). */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;

/** Build the ordered catalog; throws on a bad or duplicate name (a registry test runs it too). */
export function buildCatalog(families: readonly (readonly AnyOrquesterTool[])[]): readonly AnyOrquesterTool[] {
  const seen = new Set<string>();
  const tools: AnyOrquesterTool[] = [];
  for (const family of families) {
    for (const tool of family) {
      if (!TOOL_NAME_PATTERN.test(tool.name)) throw new Error(`catalog: bad tool name ${JSON.stringify(tool.name)}`);
      if (seen.has(tool.name)) throw new Error(`catalog: duplicate tool name ${tool.name}`);
      seen.add(tool.name);
      tools.push(tool);
    }
  }
  return Object.freeze(tools);
}

/**
 * Every tool, in catalog order: the external surface's families first, in the order the external
 * server has always listed them, then the newer families.
 */
export const CATALOG: readonly AnyOrquesterTool[] = buildCatalog([
  catalogFamily,
  sessionsFamily,
  lineageFamily,
  searchFamily,
  messagesFamily,
  outputFamily,
  requestsFamily,
  watchFamily,
  usageFamily,
  notifyFamily,
  filesFamily,
  gitFamily,
  todosFamily,
  savedPromptsFamily,
  workflowsFamily,
  agentProfileFamily,
  desktopsFamily,
  visualsFamily,
  secretsFamily,
  secretFilesFamily,
  // boxes: chat-only, advertised while a box can be rented.
  boxesFamily,
  // Knowledge Graph: chat-only, advertised while the plugin is on.
  knowledgeFamily
]);

const byAudience = new Map<Audience, readonly AnyOrquesterTool[]>();

/** The tools one audience is served, in catalog order. */
export function catalogFor(audience: Audience): readonly AnyOrquesterTool[] {
  let tools = byAudience.get(audience);
  if (!tools) {
    tools = Object.freeze(CATALOG.filter((tool) => tool.audiences.includes(audience)));
    byAudience.set(audience, tools);
  }
  return tools;
}

const byName = new Map(CATALOG.map((tool) => [tool.name, tool] as const));

/** A tool by name — for `audience`, only when served to it. */
export function toolByName(name: string, audience?: Audience): AnyOrquesterTool | undefined {
  const tool = byName.get(name);
  if (!tool) return undefined;
  return audience === undefined || tool.audiences.includes(audience) ? tool : undefined;
}
