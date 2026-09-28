/**
 * Builds the agent profile's adapters (spec §4.1): one {@link ProfileAdapter}
 * per agent CLI, each constructed with its own {@link ProfileAdapterContext}
 * and the shared backups ring and stash. An agent with no adapter here reads
 * as "not installed" in the service.
 */

import type { AgentProfileAgentId } from "@orquester/api";
import { agentProfileBackupsDir, agentProfileStashDir } from "@orquester/config";
import { ProfileBackups, ProfileStash } from "../infra/index.ts";
import { ClaudeProfileAdapter } from "./claude/index.ts";
import { GrokProfileAdapter } from "./grok/index.ts";
import type { AgentHomes, ProfileAdapter, ProfileAdapterContext } from "./types.ts";

/** What the daemon hands the factory; everything per agent is derived from it by {@link adapterContext}. */
export interface AgentProfileAdapterFactoryContext {
  homes: AgentHomes;
  /** `<appdir>`. */
  appdir: string;
  /** The agent CLI's binary as the registry resolves it NOW; `null` when not installed. */
  bin: (agent: AgentProfileAgentId) => string | null;
  /** The managed account homes of an agent's family; `[]` for an agent without managed accounts. */
  accountHomes: (agent: AgentProfileAgentId) => Promise<string[]>;
  logger: ProfileAdapterContext["logger"];
  now: () => Date;
}

/**
 * The one agent's view of the factory context, as its adapter's constructor
 * takes it. `bin` is a getter: a CLI installed or moved from Settings → Agents
 * after boot is picked up by the adapter's next CLI call.
 */
export function adapterContext(ctx: AgentProfileAdapterFactoryContext, agent: AgentProfileAgentId): ProfileAdapterContext {
  return {
    homes: ctx.homes,
    appdir: ctx.appdir,
    get bin() {
      return ctx.bin(agent);
    },
    accountHomes: () => ctx.accountHomes(agent),
    logger: ctx.logger,
    now: ctx.now
  };
}

/** Every adapter the daemon runs, sharing one backups ring and one stash. */
export function createAgentProfileAdapters(
  ctx: AgentProfileAdapterFactoryContext
): Partial<Record<AgentProfileAgentId, ProfileAdapter>> {
  const deps = {
    backups: new ProfileBackups({ dir: agentProfileBackupsDir(ctx.appdir), now: ctx.now }),
    stash: new ProfileStash({ dir: agentProfileStashDir(ctx.appdir), now: ctx.now, logger: ctx.logger })
  };
  return {
    claude: new ClaudeProfileAdapter(adapterContext(ctx, "claude"), deps),
    grok: new GrokProfileAdapter(adapterContext(ctx, "grok"), deps)
  };
}
