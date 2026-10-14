/**
 * Session tools — the toolkit list (design §1.1). Adding a toolkit is a new
 * directory beside this file plus ONE line in {@link SESSION_TOOLKITS}; see
 * `README.md`. Both the agent host and the daemon import this module
 * statically, so the two can never disagree about which tools exist (a host
 * that survived a deploy keeps the list it booted with until its
 * drain-restart, and the daemon refuses a tool it does not have).
 *
 * The framework's own tests use a test-only toolkit (`testing.ts`), never
 * registered here. An empty list would attach no `orquester` server to any
 * provider.
 */

import type { SessionToolkit } from "./contract.ts";
import { createSessionToolRegistry, type SessionToolRegistry } from "./registry.ts";
import { schedulingToolkit } from "./scheduling/index.ts";

export const SESSION_TOOLKITS: readonly SessionToolkit[] = [
  // One line per toolkit, e.g. `htmlToolkit,` (from `./html/index.ts`).
  schedulingToolkit
];

/** The production registry, built once per process. */
let productionRegistry: SessionToolRegistry | null = null;

export function sessionToolRegistry(): SessionToolRegistry {
  productionRegistry ??= createSessionToolRegistry(SESSION_TOOLKITS);
  return productionRegistry;
}

export type { SessionTool, SessionToolContext, SessionToolDefinition, SessionToolkit } from "./contract.ts";
export type { SessionToolRegistry } from "./registry.ts";
export { createSessionToolRegistry } from "./registry.ts";
