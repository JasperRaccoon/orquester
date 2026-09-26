/**
 * What an empty drill-in says, and where (§7.3, §7.6).
 *
 * A drill-in reads the thread's live window alone, and retention can empty an
 * agent's share of it — an agent's own window keeps 200 rows, the cross-agent
 * ceiling 2 000 — while its roster row says it worked. "This agent has not
 * reported anything yet" under a header showing its result was false: when
 * the roster shows work (usage, a result, a last tool, a settled status) and
 * no row of the agent's own is left, the drill-in says its rows have left the
 * window. (Paging an agent's older rows from the thread index, as the MCP's
 * drill-in does, is a follow-up.)
 *
 * "No row of its own" is judged without its launch prompts — retention keeps
 * the launch as an anchor, so a prompt can outlive every row of the run — and
 * without the live placeholders; the notice sits right under the prompts,
 * where the rows it speaks of were. Pure, so the rule is tested apart from
 * the timeline that renders it.
 */

import type { RuntimeSubagent } from "@orquester/api/agent-chat";
import { TERMINAL_SUBAGENT_STATUSES } from "@orquester/api/agent-chat";

import { agentPromptOf } from "../../../lib/agent-chat/agent-prompt.logic";
import type { AgentChatTimelineRow } from "../../../lib/agent-chat/contracts";
import { isLoopOrGoalRow } from "../../../lib/agent-chat/roster.logic";

/** An empty timeline's copy, and the row index it goes before. */
export interface EmptyNotice {
  readonly text: string;
  readonly at: number;
}

const isPromptRow = (row: AgentChatTimelineRow): boolean =>
  row.kind === "message" && agentPromptOf(row.message) !== null;

const isLivePlaceholder = (row: AgentChatTimelineRow): boolean =>
  row.kind === "working" || row.kind === "thinking";

/** The roster row says the agent did work, whatever of it the window still holds. */
function didWork(agent: RuntimeSubagent): boolean {
  return (
    (agent.usage?.totalTokens ?? 0) > 0 ||
    (agent.result?.trim().length ?? 0) > 0 ||
    (agent.lastToolName?.trim().length ?? 0) > 0 ||
    TERMINAL_SUBAGENT_STATUSES.has(agent.status)
  );
}

/**
 * The drill-in's notice, or null when a row of the agent's own is on screen.
 * `agent` is the drilled roster row, absent when the roster dropped it.
 */
export function drillInEmptyNotice(input: {
  rows: readonly AgentChatTimelineRow[];
  agent: RuntimeSubagent | undefined;
}): EmptyNotice | null {
  const { rows, agent } = input;
  if (rows.some((row) => !isPromptRow(row) && !isLivePlaceholder(row))) {
    return null;
  }
  const firstOwn = rows.findIndex((row) => !isPromptRow(row));
  const at = firstOwn < 0 ? rows.length : firstOwn;
  const live = rows.some(isLivePlaceholder);
  if (agent !== undefined && isLoopOrGoalRow(agent)) {
    // A loop and a goal print nothing: their work is rows of their own.
    return {
      text:
        agent.kind === "loop"
          ? "Each fire runs as an agent of its own, in the roster."
          : "A goal's work runs in the thread's own turns and the agents it starts.",
      at
    };
  }
  if (agent?.agentKind === "background") {
    // A shell prints output, it does not "report".
    return {
      text: TERMINAL_SUBAGENT_STATUSES.has(agent.status)
        ? "Its output has left this thread's window."
        : "No output yet.",
      at
    };
  }
  if (agent !== undefined && didWork(agent)) {
    return { text: "Its earlier rows have left this thread's window.", at };
  }
  // A live agent with nothing yet: its working rows say so.
  return live ? null : { text: "This agent has not reported anything yet.", at };
}
