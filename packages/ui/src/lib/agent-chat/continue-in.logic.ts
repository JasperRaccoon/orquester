/**
 * "Continue in another agent…" — the picker's rules (thread lineage, spec 2026-10-14 §6): which
 * agents a chat can continue in, what the fork request says for the choice, and the line that
 * tells the user what will be carried over.
 *
 * Pure: no React, no store. The handoff is counted with the same selection the agent host
 * renders it with (`@orquester/api` `handoff.ts`), over the window this client holds.
 */

import { SYSTEM_ACCOUNT_ID, type ForkSessionRequest, type RegistryEntry } from "@orquester/api";
import {
  describeHandoffSummary,
  handoffMessagesOf,
  handoffSummaryOf,
  retainedTurnsForFork,
  selectHandoffMessages,
  type ForkHandoffSummary,
  type ModelSelection,
  type ThreadForkTarget,
  type ThreadItem,
  type Turn
} from "@orquester/api/agent-chat";

/** Adapters whose provider forks a conversation natively; Grok's ACP agent has none. */
const NATIVE_FORK_ADAPTERS: ReadonlySet<string> = new Set(["claude", "codex", "opencode"]);

export interface ContinueAgentOption {
  refId: string;
  name: string;
  adapter: string;
  /** The source chat's own agent. */
  same: boolean;
}

/**
 * The agents a chat can continue in: every enabled, installed registry agent with a chat adapter,
 * the source's own first (it is the native fork), then in registry order.
 */
export function continueAgentOptions(
  agents: readonly RegistryEntry[],
  sourceRefId: string
): ContinueAgentOption[] {
  const options = agents
    .filter((entry) => entry.enabled && Boolean(entry.resolvedBin) && Boolean(entry.chat?.adapter))
    .map((entry) => ({
      refId: entry.id,
      name: entry.name,
      adapter: entry.chat!.adapter,
      same: entry.id === sourceRefId
    }));
  return [...options.filter((option) => option.same), ...options.filter((option) => !option.same)];
}

/** What the picker currently names. `accountId` is the chip's id (`"system"` for the host identity). */
export interface ContinuePick {
  refId: string;
  modelSelection: ModelSelection | null;
  accountId: string;
}

/** The source chat as the picker reads it. */
export interface ContinueSource {
  refId: string;
  adapter: string | null;
  /** The tab's account, `""` or absent for the host identity. */
  accountId?: string | undefined;
  modelSelection: ModelSelection | null;
}

function sameSelection(a: ModelSelection | null, b: ModelSelection | null): boolean {
  if (a === null || b === null) return a === b;
  const norm = (selection: ModelSelection) =>
    JSON.stringify([...(selection.options ?? [])].sort((x, y) => x.id.localeCompare(y.id)));
  return a.model === b.model && norm(a) === norm(b);
}

/** The source's account as a chip id. */
export function sourceAccountChip(source: Pick<ContinueSource, "accountId">): string {
  return source.accountId ? source.accountId : SYSTEM_ACCOUNT_ID;
}

/** How the fork the pick describes is carried over. */
export type ContinueMode =
  /** The same agent and account: the provider's own fork (the whole conversation). */
  | "native"
  /** The same agent and account, but the agent has no native fork (Grok): its transcript. */
  | "same-agent-transcript"
  /** Another agent or account: the budgeted transcript handoff. */
  | "handoff";

export function continueMode(source: ContinueSource, pick: ContinuePick, pickAdapter: string | null): ContinueMode {
  const sameAgent = pick.refId === source.refId;
  if (sameAgent && pick.accountId === sourceAccountChip(source)) {
    return pickAdapter !== null && !NATIVE_FORK_ADAPTERS.has(pickAdapter) ? "same-agent-transcript" : "native";
  }
  return "handoff";
}

/**
 * The fork request's target fields for a pick: nothing for the plain same-agent fork (today's
 * request, exactly), the model alone when only it changed, and agent, account and model for a
 * continuation.
 */
export function continueRequestFields(
  source: ContinueSource,
  pick: ContinuePick
): Pick<ForkSessionRequest, "refId" | "accountId" | "modelSelection"> {
  const sameAgent = pick.refId === source.refId;
  const sameAccount = pick.accountId === sourceAccountChip(source);
  const modelChanged = pick.modelSelection !== null && !sameSelection(pick.modelSelection, source.modelSelection);
  return {
    ...(!sameAgent ? { refId: pick.refId } : {}),
    ...(!sameAgent || !sameAccount ? { accountId: pick.accountId } : {}),
    ...((!sameAgent || modelChanged) && pick.modelSelection !== null ? { modelSelection: pick.modelSelection } : {})
  };
}

/**
 * What a handoff from `target` would carry, counted over the client's window: the kept turns'
 * whole messages within the budget. `null` when the window cannot place the fork point.
 */
export function continueHandoffPreview(
  state: { turns: readonly Turn[]; items: readonly ThreadItem[] },
  target: ThreadForkTarget,
  budgetBytes?: number
): ForkHandoffSummary | null {
  const retained = retainedTurnsForFork(state, target);
  if (retained === null) return null;
  return handoffSummaryOf(selectHandoffMessages(handoffMessagesOf(state.items, retained), budgetBytes));
}

/**
 * The picker's "what will be carried over" line.
 * - native: the provider's fork keeps everything up to the point;
 * - Grok (same agent): its own transcript fork;
 * - another agent or account: the handoff's count ("Carries the last 23 of 41 messages
 *   (≈58 KB); earlier history stays readable"), or a plain promise when the window cannot tell.
 */
export function continueSummaryText(input: {
  mode: ContinueMode;
  targetName: string;
  preview: ForkHandoffSummary | null;
  /** The client's window does not hold the oldest turns. */
  moreOlder: boolean;
}): string {
  if (input.mode === "native") {
    return `Native fork: ${input.targetName} keeps the whole conversation up to this point.`;
  }
  if (input.mode === "same-agent-transcript") {
    return `${input.targetName} has no native fork: the conversation so far is handed to it with your first message.`;
  }
  const carried =
    input.preview === null
      ? "Carries the newest whole messages (up to ≈64 KB); earlier history stays readable."
      : describeHandoffSummary(input.preview, { moreOlder: input.moreOlder });
  return `${carried} ${input.targetName} reads it with your first message.`;
}

/** The submit button's verb: a plain fork, or a continuation. */
export function continueActionLabel(mode: ContinueMode, targetName: string): string {
  return mode === "handoff" ? `Continue in ${targetName}` : "Fork";
}
