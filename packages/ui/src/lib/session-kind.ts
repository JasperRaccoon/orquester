import { REGISTRY, type RegistryEntryDef } from "@orquester/registry";
import type { AgentConversationSummary, SessionKind, SessionSummary } from "@orquester/api";

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

/** A session rendered by xterm: it has a PTY, cols/rows, and a key bar. */
export function isPtySession(session: Pick<SessionSummary, "kind">): boolean {
  return session.kind === "shell" || session.kind === "agent";
}

/** The tag a legacy agent terminal carries in the tab strip / switcher (§5.2). */
export const LEGACY_TERMINAL_TAG = "legacy terminal";

/**
 * The chat adapter that drives a registry agent id, or `null` when the catalog
 * lists the entry without one (`deepseek` is detect-only). Read from the static
 * catalog rather than from `RegistryResponse`, which carries no `chat` field —
 * the runtime entry adds availability, never capability.
 */
export function chatAdapterFor(agentRefId: string): "claude" | "codex" | "opencode" | "grok" | null {
  // `REGISTRY` is a literal-typed constant, so the union member for a row
  // without `chat` has no such property at all; widen to the declared shape.
  const agents: readonly RegistryEntryDef[] = REGISTRY.agents;
  return agents.find((a) => a.id === agentRefId)?.chat?.adapter ?? null;
}

/** Whether "+ → this agent" may open a chat tab at all (§5.3). */
export function canOpenChat(agentRefId: string): boolean {
  return chatAdapterFor(agentRefId) !== null;
}

/**
 * The session kind an agent row launches as. Agent tabs are chat only
 * (§1 decision table: *replace*, do not coexist), so an entry with an adapter
 * becomes `agent-chat`; one without has no launch path left at all and the
 * caller must not offer it.
 */
export function launchKindForAgent(agentRefId: string): SessionKind | null {
  return canOpenChat(agentRefId) ? "agent-chat" : null;
}

/**
 * Whether a conversation row from `GET /api/agents/conversations` can seed a
 * chat thread's resume cursor.
 *
 * Wider than the terminal path's {@link isResumableConversation}: a `cliproxy`
 * row is resumable in chat for the first time, because the adapter resumes
 * under the same HOME instead of going through the launcher's `resumeArgs`
 * (§5.3). It is only offered where the agent that would run it actually has an
 * adapter.
 */
export function isChatResumableConversation(conversation: AgentConversationSummary): boolean {
  return canOpenChat(chatLaunchRefId(conversation));
}

/**
 * The registry entry a resumed conversation launches under. A `cliproxy` row
 * belongs to the `claudex`/`claudemix` launcher that owns the proxy home, not
 * to plain `claude`: launching it as `claude` would look for the transcript in
 * the daemon's own HOME and find nothing (the bug `isResumableConversation`
 * hides on the terminal path).
 */
export function chatLaunchRefId(conversation: AgentConversationSummary): string {
  if (conversation.home === "cliproxy" && conversation.proxyRefId) {
    return conversation.proxyRefId;
  }
  return conversation.agentRefId;
}

/** Longest client-seeded thread title (§7.7; T3 `packages/shared/src/String.ts:1-8`). */
export const THREAD_TITLE_SEED_MAX = 50;

/**
 * The client-seeded thread title (§7.7). There is no title-generation service:
 * this seed *is* the title until a provider offers a better one through
 * `thread.metadata.updated`, and the host only replaces it while it is still
 * exactly the seed or exactly the default.
 *
 * T3's fallback chain, in order: the first message's plain text with context
 * references stripped → the first attachment's name (`Image: …` / `File: …`) →
 * the literal default.
 *
 * *Ported from T3 Code (MIT): `apps/web/src/components/ChatView.tsx:8271-8287`.*
 */
export const DEFAULT_THREAD_TITLE = "New thread";

export function seedThreadTitle(
  text: string,
  attachments: readonly { name: string; kind?: "image" | "file" }[] = []
): string {
  const plain = stripContextReferences(text).trim();
  if (plain.length > 0) {
    return truncateTitle(plain);
  }
  const first = attachments[0];
  if (first) {
    return truncateTitle(`${first.kind === "image" ? "Image" : "File"}: ${first.name}`);
  }
  return DEFAULT_THREAD_TITLE;
}

/**
 * Drop the composer's own markup from a title seed: `$skill` mentions, `@path`
 * context chips and a leading `/command`, plus collapsing whitespace so a
 * multi-line first message becomes one line.
 */
function stripContextReferences(text: string): string {
  return text
    .replace(/^\s*\/\S+\s*/, "")
    .replace(/(^|\s)[$@]\S+/g, "$1")
    .replace(/\s+/g, " ");
}

/** T3's truncation: a hard cut at the cap with a single ellipsis, never mid-cap. */
function truncateTitle(value: string): string {
  if (value.length <= THREAD_TITLE_SEED_MAX) {
    return value;
  }
  return `${value.slice(0, THREAD_TITLE_SEED_MAX - 1).trimEnd()}…`;
}
