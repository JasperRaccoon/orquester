/**
 * What the History panel reads off a chat's thread store — in ONE selector,
 * one subscription, and one value that changes only when something the panel
 * shows did.
 *
 * The panel lives outside the chat view and must not re-render on every
 * streamed token (`useAgentChatThreadSelector`'s contract): every field here
 * is either one the store keeps by identity across tokens (turns,
 * checkpoints, pages, actions), a primitive, or a memoised derivation that
 * hands back its last value until its content moves (the loaded prompts, the
 * rewind facts). The loaded history (pages, bridge) is walked only when one
 * of its arrays is replaced; per token, only the window's array is. The
 * object itself is handed back by identity while every field is.
 */

import { SETTLED_TURN_STATES } from "@orquester/api/agent-chat";
import type { Checkpoint, ThreadHistoryPage, Turn } from "@orquester/api/agent-chat";

import type { AgentChatActions } from "../agent-chat/contracts";
import type { AgentChatThreadState } from "../agent-chat/store";
import { createLoadedPromptsMemo, type LoadedPrompts } from "./prompts.logic";
import {
  createRewindTargetsMemo,
  latestLoadedCompactionAt,
  type RewindBusyInput,
  type RewindFacts
} from "./rewind.logic";

export interface HistoryThreadInputs {
  /** A snapshot has landed: the fold's turns can judge an index entry. */
  hasHead: boolean;
  /** The registry id the tab launched from — the provider snapshot's key. */
  refId: string;
  /** The thread's working directory (where checkpoints are captured). */
  cwd: string | null;
  /**
   * The snapshot's word on the host's index for this thread
   * (`history.bounds.indexed`); null before a snapshot, and from a host that
   * predates the index.
   */
  historyIndexed: boolean | null;
  turns: readonly Turn[];
  checkpoints: readonly Checkpoint[];
  /** The chat's loaded history pages (oldest first). */
  pages: readonly ThreadHistoryPage[];
  loaded: LoadedPrompts;
  rewind: RewindFacts;
  busy: RewindBusyInput;
  actions: AgentChatActions;
}

/** A turn is running: not yet settled (AgentChatView's `turnActive`). */
export function isTurnActive(state: Pick<AgentChatThreadState, "slice">): boolean {
  const status = state.slice.turnStatus;
  return status !== null && !SETTLED_TURN_STATES.has(status);
}

/** The composer picker's busy flags, read off a thread's state. */
export function rewindBusyOf(state: Pick<AgentChatThreadState, "slice" | "reverting">): RewindBusyInput {
  return {
    isTurnActive: isTurnActive(state),
    reverting: state.reverting,
    hasPendingRequest:
      state.slice.pending.approvals.length + state.slice.pending.userInputs.length > 0
  };
}

function sameBusy(left: RewindBusyInput, right: RewindBusyInput): boolean {
  return (
    left.isTurnActive === right.isTurnActive &&
    left.reverting === right.reverting &&
    left.hasPendingRequest === right.hasPendingRequest
  );
}

/** One selector per panel instance: it remembers only the last state it saw. */
export function createHistoryThreadSelector(): (state: AgentChatThreadState) => HistoryThreadInputs {
  const loadedPrompts = createLoadedPromptsMemo();
  const rewindTargets = createRewindTargetsMemo();
  let last: HistoryThreadInputs | null = null;
  return (state) => {
    const { slice } = state;
    const { history } = slice;
    const busy = rewindBusyOf(state);
    const targets = rewindTargets(state.rows);
    const latestCompactionAt = latestLoadedCompactionAt({
      pages: history.pages,
      bridge: history.bridge,
      entries: slice.entries
    });
    const next: HistoryThreadInputs = {
      hasHead: slice.head !== null,
      refId: slice.head?.refId ?? "",
      cwd: slice.head?.cwd ?? null,
      historyIndexed: history.bounds?.indexed ?? null,
      turns: slice.turns,
      checkpoints: slice.checkpoints,
      pages: history.pages,
      loaded: loadedPrompts({
        pages: history.pages,
        bridge: history.bridge,
        entries: slice.entries,
        turns: slice.turns
      }),
      rewind:
        last !== null &&
        last.rewind.targets === targets &&
        last.rewind.latestCompactionAt === latestCompactionAt
          ? last.rewind
          : { targets, latestCompactionAt },
      busy: last !== null && sameBusy(last.busy, busy) ? last.busy : busy,
      actions: state.actions
    };
    if (
      last !== null &&
      last.hasHead === next.hasHead &&
      last.refId === next.refId &&
      last.cwd === next.cwd &&
      last.historyIndexed === next.historyIndexed &&
      last.turns === next.turns &&
      last.checkpoints === next.checkpoints &&
      last.pages === next.pages &&
      last.loaded === next.loaded &&
      last.rewind === next.rewind &&
      last.busy === next.busy &&
      last.actions === next.actions
    ) {
      return last;
    }
    last = next;
    return next;
  };
}
