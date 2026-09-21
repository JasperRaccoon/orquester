/**
 * Agent chat — **inert stub hooks** so components compile today.
 *
 * Package **W11** replaces every body here with the real zustand slice and the
 * `Transporter.agentChat` transport (§7.2, §6.3 client side). The signatures
 * are the contract and must not change; `contracts.ts` is additive-only.
 *
 * Every action rejects rather than resolving: a silent no-op would let a
 * component ship looking wired up.
 */

import { useMemo } from "react";

import { DEFAULT_INTERACTION_MODE } from "@orquester/api/agent-chat";

import type {
  AgentChatActions,
  AgentChatPendingView,
  AgentChatRosterView,
  AgentChatStatusView,
  AgentChatThreadSlice,
  AgentChatThreadView,
  DisclosureState,
  UseAgentChatPending,
  UseAgentChatRoster,
  UseAgentChatStatus,
  UseAgentChatThread,
  UseProviderSnapshot
} from "./contracts";

const NOT_WIRED = "agent-chat: client state not implemented (package W11)";

const EMPTY_DISCLOSURES: DisclosureState = {
  expandedTurnIds: [],
  expandedGroupIds: [],
  expandedAgentIds: [],
  expandedReasoningIds: [],
  toolOutputOffsets: {}
};

function emptySlice(sessionId: string): AgentChatThreadSlice {
  return {
    sessionId,
    head: null,
    entries: [],
    turns: [],
    checkpoints: [],
    pending: { approvals: [], userInputs: [] },
    roster: [],
    turnStatus: null,
    sessionStatus: null,
    backgroundLiveness: null,
    contextWindow: null,
    seq: 0,
    connection: "idle",
    follow: true,
    scroll: null,
    disclosures: EMPTY_DISCLOSURES,
    interactionMode: DEFAULT_INTERACTION_MODE,
    queue: [],
    respondingRequestIds: [],
    errorBanner: null
  };
}

const reject = (): Promise<never> => Promise.reject(new Error(NOT_WIRED));
const ignore = (): void => {};

const STUB_ACTIONS: AgentChatActions = {
  sendTurn: reject,
  steer: reject,
  interrupt: reject,
  respondApproval: reject,
  answerQuestion: reject,
  dismissQuestion: reject,
  revert: reject,
  compact: reject,
  setMode: reject,
  stopSession: reject,
  uploadAttachment: reject,
  queueMessage: ignore,
  sendQueuedNow: reject,
  returnQueuedToComposer: ignore,
  drainQueueToComposer: ignore,
  setInteractionMode: ignore,
  setFollow: ignore,
  setDisclosure: ignore,
  dismissErrorBanner: ignore,
  refresh: reject
};

export const useAgentChatThread: UseAgentChatThread = (sessionId) => {
  return useMemo<AgentChatThreadView>(
    () => ({
      slice: emptySlice(sessionId),
      actions: STUB_ACTIONS,
      rows: [],
      activePlan: null
    }),
    [sessionId]
  );
};

export const useAgentChatRoster: UseAgentChatRoster = (sessionId) => {
  void sessionId;
  return useMemo<AgentChatRosterView>(
    () => ({
      agents: [],
      panel: {
        workflows: [],
        directAgents: [],
        runningCount: 0,
        waitingCount: 0,
        idleCount: 0,
        settledCount: 0,
        totalTokens: 0,
        hasAgents: false,
        liveCount: 0
      },
      backgroundLiveness: null,
      stopping: false
    }),
    []
  );
};

export const useAgentChatPending: UseAgentChatPending = (sessionId) => {
  void sessionId;
  return useMemo<AgentChatPendingView>(
    () => ({ approvals: [], userInputs: [], respondingRequestIds: [], totalCount: 0 }),
    []
  );
};

export const useAgentChatStatus: UseAgentChatStatus = (sessionId) => {
  void sessionId;
  return useMemo<AgentChatStatusView>(
    () => ({
      sessionStatus: null,
      turnStatus: null,
      connection: "idle",
      contextWindow: null,
      reportsContextWindow: false,
      activityLabel: null,
      turnStartedAt: null
    }),
    []
  );
};

export const useProviderSnapshot: UseProviderSnapshot = (refId) => {
  void refId;
  return null;
};
