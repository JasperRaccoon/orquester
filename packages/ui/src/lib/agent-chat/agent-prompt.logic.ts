/**
 * Agent chat — an agent's launch prompt, at the head of its drill-in (§7.6:
 * "its prompt at the top").
 *
 * The prompt rides the agent's `task.started` activity as `payload.prompt`:
 * verbatim, what THIS launch was given — a relaunch's start carries its own —
 * bounded at rest by ingestion (`payload.promptTruncated` when cut there) and
 * capped on the wire like any string (the item's `truncated`; the whole stored
 * value is one item read away). It is absent where the provider reported none,
 * on every log written before it existed, and on a shell's or a monitor's
 * start — and then there is no prompt row: the client never invents one.
 *
 * Each launch that carries one becomes a user-role message in the drill-in's
 * items, at the launch's place: to the agent the prompt IS its user turn, so
 * it heads the run it started exactly as a user's message heads a turn in the
 * thread — a live run's working row follows it, and the fold of the rows
 * right after it is timed from it (only those: the first row after it,
 * turnless or not, ends its reach, `deriveTurnFolds`). The launch is found by
 * `payload.taskId` whoever owns its row: Claude's is the PARENT's (it stamps a
 * launch with its owner), the other adapters stamp it with the agent. The
 * message is the same object for the same launch row, so the streaming fast
 * paths hold, and a registry marks it so the timeline renders it as the
 * prompt it is ({@link agentPromptOf}).
 *
 * No React import.
 */

import type { ThreadActivityItem, ThreadItem, ThreadMessageItem } from "@orquester/api/agent-chat";

import { itemsForAgent } from "./entries.logic";

/** What the prompt row says of the prompt beside its text. */
export interface AgentPrompt {
  /** The launch's activity: the item read that holds the whole stored prompt. */
  readonly itemId: string;
  /** The wire cut it (§5.6): the whole of it is one item read away. */
  readonly truncated: boolean;
  /** Ingestion cut it at rest: only its start was ever kept. */
  readonly cutAtRest: boolean;
}

/** The prompt messages this module made, and what each one says of its prompt. */
const promptByMessage = new WeakMap<ThreadMessageItem, AgentPrompt>();

/** Per launch row, its prompt message (or null) for one agent. */
const messageByLaunch = new WeakMap<ThreadActivityItem, { agentId: string; message: ThreadMessageItem | null }>();

/** The prompt a message renders as, when it is one — never an ordinary message. */
export function agentPromptOf(message: ThreadMessageItem): AgentPrompt | null {
  return promptByMessage.get(message) ?? null;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** The launch `item` is, of `agentId`: a `task.started` naming it. */
function launchOf(item: ThreadItem, agentId: string): ThreadActivityItem | null {
  if (item.kind !== "activity" || item.activityKind !== "task.started") {
    return null;
  }
  return asRecord(item.payload)?.taskId === agentId ? item : null;
}

/** The message a launch's prompt becomes, memoised per launch row. */
function launchPromptMessage(launch: ThreadActivityItem, agentId: string): ThreadMessageItem | null {
  const cached = messageByLaunch.get(launch);
  if (cached !== undefined && cached.agentId === agentId) {
    return cached.message;
  }
  const payload = asRecord(launch.payload);
  const prompt = typeof payload?.prompt === "string" && payload.prompt.trim().length > 0 ? payload.prompt : null;
  let message: ThreadMessageItem | null = null;
  if (prompt !== null) {
    message = {
      kind: "message",
      id: `agent-prompt:${launch.id}`,
      role: "user",
      text: prompt,
      turnId: launch.turnId,
      streaming: false,
      createdAt: launch.createdAt,
      updatedAt: launch.createdAt,
      // The agent's own, so its drill-in keeps it and the thread's never shows it.
      agentId
    };
    promptByMessage.set(message, {
      itemId: launch.id,
      truncated: payload?.truncated === true,
      cutAtRest: payload?.promptTruncated === true
    });
  }
  messageByLaunch.set(launch, { agentId, message });
  return message;
}

/**
 * One agent's drill-in items: its own ({@link itemsForAgent}), in order, with
 * the prompt of each launch that carries one just before the launch's place.
 * A launch delivered twice — the same launch id (`payload.toolUseId`) — is
 * one prompt, the first.
 */
export function drillInItems(items: readonly ThreadItem[], agentId: string): ThreadItem[] {
  const own = itemsForAgent(items, agentId);
  let prompts: Map<ThreadItem, ThreadMessageItem> | null = null;
  const launches = new Set<string>();
  for (const item of items) {
    const launch = launchOf(item, agentId);
    if (launch === null) {
      continue;
    }
    const message = launchPromptMessage(launch, agentId);
    if (message === null) {
      continue;
    }
    const launchId = asRecord(launch.payload)?.toolUseId;
    if (typeof launchId === "string" && launchId.length > 0) {
      if (launches.has(launchId)) {
        continue;
      }
      launches.add(launchId);
    }
    (prompts ??= new Map()).set(item, message);
  }
  if (prompts === null) {
    return own;
  }
  const owned = new Set<ThreadItem>(own);
  const merged: ThreadItem[] = [];
  for (const item of items) {
    const prompt = prompts.get(item);
    if (prompt !== undefined) {
      merged.push(prompt);
    }
    if (owned.has(item)) {
      merged.push(item);
    }
  }
  return merged;
}
