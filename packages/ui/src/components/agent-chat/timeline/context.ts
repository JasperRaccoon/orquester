import React from "react";

import type { RuntimeSubagent } from "@orquester/api";

import type { DisclosureState } from "../../../lib/agent-chat/contracts";

/**
 * Shared row state, carried on a context rather than threaded through props.
 *
 * Rows are `memo`ised on their row object (§7.2: entries → rows → stable rows),
 * so anything passed to them as a prop would defeat that memo the moment its
 * identity changed. A context is read where it is used and does not participate
 * in the memo comparison at all.
 *
 * **Nothing that ticks lives here.** `nowIso` is deliberately absent, exactly as
 * in T3: the elapsed timers are self-ticking leaves (`ElapsedTicker`), because a
 * clock on this context would re-render every row once a second.
 * *T3: `MessagesTimeline.tsx:267-272`.*
 */
export interface TimelineRowContextValue {
  /** The project directory, so a changed-file path renders workspace-relative. */
  workspaceRoot: string | undefined;
  /** The drill-in dispatches no commands; every affordance below is withheld. */
  readOnly: boolean;
  canRevert: boolean;
  /**
   * A turn is running or a revert is in flight: "Rewind to here" is shown but
   * disabled, and says it waits for the agent to be idle. Flips at turn
   * boundaries only, so it is safe on this context (nothing here ticks).
   */
  revertBusy: boolean;
  /**
   * The thread's started turns (`startedTurns(turns).length`), so a user row
   * can say how many turns its rewind removes. Changes once per turn.
   */
  startedTurnCount: number;
  disclosures: DisclosureState;
  /** The roster a spawn row resolves its label and member list against. */
  roster: readonly RuntimeSubagent[];
  /**
   * The current per-cwd skill names, for re-chipping `$mentions` in a sent
   * message (§4.6.7). Empty means no chips — a mention only reads as one while
   * the skill it names exists.
   */
  skills: readonly string[];

  isExpanded: (id: string) => boolean;
  setExpanded: (id: string, expanded: boolean) => void;
  isReasoningExpanded: (id: string) => boolean;
  setReasoningExpanded: (id: string, expanded: boolean) => void;
  isTurnExpanded: (id: string) => boolean;
  setTurnExpanded: (id: string, expanded: boolean) => void;
  isAgentRowExpanded: (id: string) => boolean;
  setAgentRowExpanded: (id: string, expanded: boolean) => void;
  /** Scroll offset inside one expanded tool output, remembered per row (§7.2). */
  toolOutputOffset: (id: string) => number;
  setToolOutputOffset: (id: string, offset: number) => void;

  /** A confirmed "Rewind to here" (§5.5). Conversation only; files stay. */
  onRevert: (input: { messageId: string; targetTurnCount: number }) => void;
  onOpenTurnDiff: (turnCount: number) => void;
  onOpenFile: (path: string) => void;
  onLoadFullOutput: (itemId: string) => void;
  /**
   * The whole markdown of a plan proposal — the store's `readFullPlanMarkdown`,
   * the read Implement makes: as is when intact, read back when the wire cut it
   * (§5.6). The plan card's Copy and Download go through it
   * (`wholePlanMarkdown`), so neither hands over the cut text. Rejects rather
   * than ever answer it.
   */
  readFullPlanMarkdown: (plan: { id: string; planMarkdown: string; truncated?: true }) => Promise<string>;
  onOpenAgent: (agentId: string) => void;
  onSendQueuedNow: (queuedId: string) => void;
  onReturnQueuedToComposer: (queuedId: string) => void;
  /**
   * The provider can move a running command to the background on request
   * (`supportsBackgroundTasks`); the live command row then offers the button.
   */
  canBackgroundTasks: boolean;
  /** The user's Ctrl+B on one running tool call. */
  onBackgroundTool: (toolUseId: string) => void;
  /**
   * This timeline is a background shell's drill-in (§7.6), where the shell's
   * command and its output ARE the view. A tool row's output pane is capped
   * short everywhere else because it is one line of a conversation; here it is
   * the content, so the shell variant gives it room and follows it as it
   * streams. Never true in the parent timeline.
   */
  backgroundShell: boolean;
}

const NOOP = (): void => {};

const FALLBACK: TimelineRowContextValue = {
  workspaceRoot: undefined,
  readOnly: true,
  canRevert: false,
  revertBusy: false,
  startedTurnCount: 0,
  disclosures: {
    expandedTurnIds: [],
    expandedGroupIds: [],
    expandedAgentIds: [],
    expandedReasoningIds: [],
    toolOutputOffsets: {}
  },
  roster: [],
  skills: [],
  isExpanded: () => false,
  setExpanded: NOOP,
  isReasoningExpanded: () => false,
  setReasoningExpanded: NOOP,
  isTurnExpanded: () => false,
  setTurnExpanded: NOOP,
  isAgentRowExpanded: () => false,
  setAgentRowExpanded: NOOP,
  toolOutputOffset: () => 0,
  setToolOutputOffset: NOOP,
  onRevert: NOOP,
  onOpenTurnDiff: NOOP,
  onOpenFile: NOOP,
  onLoadFullOutput: NOOP,
  // Outside a timeline there is no thread to read a cut plan back from.
  readFullPlanMarkdown: (plan) =>
    plan.truncated === true
      ? Promise.reject(new Error("The full plan could not be loaded."))
      : Promise.resolve(plan.planMarkdown),
  onOpenAgent: NOOP,
  onSendQueuedNow: NOOP,
  onReturnQueuedToComposer: NOOP,
  canBackgroundTasks: false,
  onBackgroundTool: NOOP,
  backgroundShell: false
};

export const TimelineRowContext = React.createContext<TimelineRowContextValue>(FALLBACK);

export function useTimelineRowContext(): TimelineRowContextValue {
  return React.useContext(TimelineRowContext);
}
