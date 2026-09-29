import { REGISTRY, type RegistryEntryDef } from "@orquester/registry";
import type { AgentConversationSummary, RegistryEntry, SessionSummary } from "@orquester/api";

import { DEFAULT_THREAD_TITLE } from "./agent-chat/title.logic";

/**
 * Session-kind predicates every ambient surface shares (spec §5.2, §5.3, §7.1).
 *
 * `kind` is a *session* discriminant, not a tab discriminant: `ProjectTab.type`
 * names the tab arm and `SessionSummary.kind` names what the daemon is running.
 * Three kinds exist after the chat GUI lands:
 *
 * - `shell`      — a plain terminal, unchanged.
 * - `agent`      — a **legacy** agent terminal (§5.2): a pre-chat record with a
 *                  live `orq-*` tmux session, reattached as a terminal until it
 *                  is closed and tagged as such. Nothing creates one any more.
 * - `agent-chat` — the chat GUI. Never a `REGISTRY` catalog kind: the entry is
 *                  still named by `refId`, which is why every icon/label lookup
 *                  keeps passing the agent id.
 *
 * Kept as plain functions (not a hook, not a store selector) so the same rule is
 * used by React surfaces, the global shortcut listener's out-of-React snapshot
 * and the tests.
 */

/** A chat tab: the agent is driven over its machine protocol, not a PTY. */
export function isChatSession(session: Pick<SessionSummary, "kind">): boolean {
  return session.kind === "agent-chat";
}

/**
 * A pre-chat agent terminal. Kept alive until its tab is closed (§5.2 migration);
 * surfaces tag it so it is not mistaken for a chat tab that failed to render.
 */
export function isLegacyAgentTerminal(session: Pick<SessionSummary, "kind">): boolean {
  return session.kind === "agent";
}

/**
 * Either flavour of "a coding agent lives in this tab". Every kind-branching
 * surface listed in `orq-3-ui-surfaces.md` §1 — the Attention Center, the
 * `Ctrl+Shift+A` cycle, the browser element picker's target list — asks this
 * rather than `kind === "agent"`, which would silently drop every chat tab.
 */
export function isAgentLikeSession(session: Pick<SessionSummary, "kind">): boolean {
  return session.kind === "agent" || session.kind === "agent-chat";
}

/**
 * Chat capability comes from the static catalog; the runtime registry only
 * adds availability and does not carry adapter information.
 */
export function canOpenChat(agentRefId: string): boolean {
  // `REGISTRY` is a literal-typed constant, so the union member for a row
  // without `chat` has no such property at all; widen to the declared shape.
  const agents: readonly RegistryEntryDef[] = REGISTRY.agents;
  return agents.find((a) => a.id === agentRefId)?.chat?.adapter != null;
}

/**
 * Whether a conversation row from `GET /api/agents/conversations` can seed a
 * chat thread's resume cursor: the adapter resumes under the conversation's
 * own HOME instead of going through the launcher's `resumeArgs` (§5.3), so a
 * row is offered wherever the agent that wrote it has an adapter.
 */
export function isChatResumableConversation(conversation: AgentConversationSummary): boolean {
  return canOpenChat(conversation.agentRefId);
}

/**
 * Whether a project's resume lists offer a conversation: the registry entry it
 * launches under is installed, and chat can resume it
 * ({@link isChatResumableConversation}). This is the filter behind both of
 * `ProjectOverview`'s lists: the overview's own and the empty chat tab's.
 *
 * `agentsById` is the runtime registry keyed by id. An entry is `enabled` only
 * when its binary was found.
 */
export function isResumableByInstalledAgent(
  conversation: AgentConversationSummary,
  agentsById: ReadonlyMap<string, Pick<RegistryEntry, "enabled">>
): boolean {
  return (
    Boolean(agentsById.get(conversation.agentRefId)?.enabled) &&
    isChatResumableConversation(conversation)
  );
}

/**
 * Whether one agent's "Resume a conversation" section in the "+" menu lists a
 * conversation: the row launches under exactly that agent, and chat can resume
 * it.
 */
export function isResumableByAgent(conversation: AgentConversationSummary, agentId: string): boolean {
  return conversation.agentRefId === agentId && isChatResumableConversation(conversation);
}

/**
 * Whether a tab's title is still the **launcher's** own, i.e. nobody has
 * chosen it: the literal default, the registry entry's display name, or the
 * bare entry id.
 *
 * A companion to `canReplaceThreadTitle` (`lib/agent-chat/title.logic`), not a
 * copy of it. That one asks "is this still the default or the seed we already
 * wrote", which is the *host's* gate; this one runs before any seed exists, at
 * the moment the first message lands, and the only titles in play then are the
 * ones `openTab` puts on a fresh chat tab.
 */
export function isDefaultThreadTitle(title: string, agentRefId: string): boolean {
  if (title === DEFAULT_THREAD_TITLE || title === agentRefId) {
    return true;
  }
  const agents: readonly RegistryEntryDef[] = REGISTRY.agents;
  return agents.find((a) => a.id === agentRefId)?.name === title;
}
