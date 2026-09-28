/**
 * Which agent the Agent profile panel shows before the user picks one (spec
 * §7.3): the visible chat tab's agent, else the one last picked on this
 * device, else the first installed one. Pure — the container reads the chat,
 * the providers and the remembered pick and passes them in.
 */

import { AGENT_PROFILE_AGENTS, isAgentProfileAgentId, type AgentProfileAgentId } from "@orquester/api";

/**
 * The agent a chat tab's `refId` names: the provider that serves it (the
 * runtime catalogue, `providerForRefId`), else the static registry's chat
 * adapter for that entry — a catalogue that has not loaded yet.
 */
export function agentForRefId(
  refId: string | null | undefined,
  providers: readonly { id: string; refIds: readonly string[] }[],
  registryAgents: readonly { id: string; chat?: { adapter: string } }[]
): AgentProfileAgentId | null {
  if (!refId) return null;
  const provider = providers.find((candidate) => candidate.refIds.includes(refId));
  if (provider !== undefined && isAgentProfileAgentId(provider.id)) return provider.id;
  const adapter = registryAgents.find((entry) => entry.id === refId)?.chat?.adapter;
  if (isAgentProfileAgentId(adapter)) return adapter;
  return isAgentProfileAgentId(refId) ? refId : null;
}

/**
 * The agent to show. An agent known NOT to be installed is passed over
 * (`installed` answers `null` while unknown — the overview not loaded yet —
 * which does not pass it over).
 */
export function defaultAgentProfileAgent(input: {
  chatAgent: AgentProfileAgentId | null;
  remembered: AgentProfileAgentId | null;
  installed: (agent: AgentProfileAgentId) => boolean | null;
}): AgentProfileAgentId {
  const usable = (agent: AgentProfileAgentId | null): agent is AgentProfileAgentId =>
    agent !== null && input.installed(agent) !== false;
  if (usable(input.chatAgent)) return input.chatAgent;
  if (usable(input.remembered)) return input.remembered;
  return (
    AGENT_PROFILE_AGENTS.find((agent) => input.installed(agent) === true) ??
    input.remembered ??
    input.chatAgent ??
    AGENT_PROFILE_AGENTS[0]
  );
}
