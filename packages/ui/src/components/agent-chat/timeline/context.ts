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

  onRevert: (targetTurnCount: number) => void;
  onOpenTurnDiff: (turnCount: number) => void;
  onOpenFile: (path: string) => void;
  onLoadFullOutput: (itemId: string) => void;
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
}

const NOOP = (): void => {};

const FALLBACK: TimelineRowContextValue = {
  workspaceRoot: undefined,
  readOnly: true,
  canRevert: false,
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
  onOpenAgent: NOOP,
  onSendQueuedNow: NOOP,
  onReturnQueuedToComposer: NOOP,
  canBackgroundTasks: false,
  onBackgroundTool: NOOP,
};

export const TimelineRowContext = React.createContext<TimelineRowContextValue>(FALLBACK);

export function useTimelineRowContext(): TimelineRowContextValue {
  return React.useContext(TimelineRowContext);
}
