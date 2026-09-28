/**
 * Builds the agent profile's adapters (spec §4.1): one {@link ProfileAdapter}
 * per agent CLI, each constructed with its own {@link ProfileAdapterContext}.
 * An agent with no adapter here reads as "not installed" in the service.
 */

import type { AgentProfileAgentId } from "@orquester/api";
import type { AgentHomes, ProfileAdapter, ProfileAdapterContext } from "./types.ts";

/** What the daemon hands the factory; everything per agent is derived from it by {@link adapterContext}. */
export interface AgentProfileAdapterFactoryContext {
  homes: AgentHomes;
  /** `<appdir>`. */
  appdir: string;
  /** The agent CLI's binary as the registry resolved it (at build time); `null` when not installed. */
  bin: (agent: AgentProfileAgentId) => string | null;
  /** The managed account homes of an agent's family; `[]` for an agent without managed accounts. */
  accountHomes: (agent: AgentProfileAgentId) => Promise<string[]>;
  logger: ProfileAdapterContext["logger"];
  now: () => Date;
}

/** The one agent's view of the factory context, as its adapter's constructor takes it. */
export function adapterContext(ctx: AgentProfileAdapterFactoryContext, agent: AgentProfileAgentId): ProfileAdapterContext {
  return {
    homes: ctx.homes,
    appdir: ctx.appdir,
    bin: ctx.bin(agent),
    accountHomes: () => ctx.accountHomes(agent),
    logger: ctx.logger,
    now: ctx.now
  };
}

/**
 * Every adapter the daemon runs. Each adapter registers here, keyed by its
 * agent and built from `adapterContext(ctx, <agent>)`, e.g.
 * `claude: createClaudeProfileAdapter(adapterContext(ctx, "claude"))`.
 */
export function createAgentProfileAdapters(
  ctx: AgentProfileAdapterFactoryContext
): Partial<Record<AgentProfileAgentId, ProfileAdapter>> {
  void ctx;
  return {};
}
