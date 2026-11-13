/**
 * The live half of a parent's delegated chats, read from the app's tabs: each child's view, its
 * meta line and opening it. The timeline's subagent strip gets these through the app's chat host
 * (`ChatHost.delegates`), so the timeline imports no app store; the roster's delegated rows, which
 * only the app renders, import them here.
 */

import React from "react";
import { useShallow } from "zustand/react/shallow";
import type { SessionSummary } from "@orquester/api";

import { shortAccountLabel } from "../../../lib/account-label";
import { delegateChildView, type DelegateChildRef, type DelegateChildView } from "../../../lib/agent-chat/delegates.logic";
import { jumpToProject } from "../../../lib/session-nav";
import { useAppStore } from "../../../store/app";
import { formatSubagentModelLabel } from "../roster/format";

/** The children's tabs, live: re-renders only when one of THESE summaries changes. */
export function useDelegateChildViews(refs: readonly DelegateChildRef[]): DelegateChildView[] {
  const sessions = useAppStore(
    useShallow((state) =>
      refs.map((ref) =>
        ref.threadId === null
          ? undefined
          : state.sessions.find((session) => session.id === ref.threadId && session.kind === "agent-chat")
      )
    )
  );
  return React.useMemo(() => refs.map((ref, index) => delegateChildView(ref, sessions[index])), [refs, sessions]);
}

/**
 * A child's second line: its agent's name, its model and — where the tab strip shows one — its
 * managed account. "" for a child with none of them known (its tab is gone).
 */
export function useDelegateMetaLine(view: Pick<DelegateChildView, "refId" | "model" | "accountId">): string {
  const agentName = useAppStore((state) =>
    view.refId === null ? undefined : (state.registry.agents.find((agent) => agent.id === view.refId)?.name ?? view.refId)
  );
  const accountLabel = useAppStore((state) =>
    view.accountId === null ? "" : shortAccountLabel(state.agentAccounts?.accounts.find((account) => account.id === view.accountId)?.label)
  );
  return [agentName, formatSubagentModelLabel(view.model, null), accountLabel].filter((part): part is string => Boolean(part)).join(" · ");
}

/**
 * Focus a delegated child's tab: in this project, its tab; in another project (a task delegated
 * across projects), that project with its tab. False when the tab is gone.
 */
export function openDelegateTab(sessionId: string): boolean {
  const state = useAppStore.getState();
  const session: SessionSummary | undefined = state.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) return false;
  if (state.currentProject?.path !== session.projectPath) {
    const project = state.projects.find((candidate) => candidate.path === session.projectPath);
    if (project) {
      jumpToProject({ project, sessionId });
      return true;
    }
  }
  state.activateTab(sessionId);
  return true;
}
