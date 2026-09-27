/**
 * What an empty drill-in says, and where (§7.3, §7.6).
 *
 * A drill-in reads the thread's live window alone, and retention can empty an
 * agent's share of it — an agent's own window keeps 200 rows, the cross-agent
 * ceiling 2 000 — while its roster row says it worked. But an agent can have
 * no rows for other reasons too: it was stopped or declined before it did
 * anything, a Codex child's words and thoughts are no rows at all, an agent's
 * own task rows are hidden in its view. So the copy is three tiers:
 *
 *  - a LIVE agent with no rows of its own has not reported anything yet (its
 *    live rows sit under the line);
 *  - a settled one's rows have LEFT the window only with evidence of both
 *    halves — the thread's window has dropped rows (`retentionDropped`,
 *    `windowHasDropped`) and the agent did real tool work, which leaves rows
 *    ({@link didToolWork});
 *  - otherwise a neutral line that is true whatever happened.
 *
 * A background shell follows the same rule in a shell's words. (Paging an
 * agent's older rows from the thread index, as the MCP's drill-in does, is a
 * follow-up.)
 *
 * "No rows of its own" is judged without its launch prompts — retention keeps
 * the launch as an anchor, so a prompt can outlive every row of the run — and
 * without the live placeholders; the notice sits right under the prompts,
 * where the rows it speaks of would be. Pure, so the rule is tested apart from
 * the timeline that renders it.
 */

import type { RuntimeSubagent } from "@orquester/api/agent-chat";
import { ACTIVE_SUBAGENT_STATUSES } from "@orquester/api/agent-chat";

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

/**
 * The item types a roster tick can name as the "last tool" that are no tool:
 * Codex's child tick carries the ITEM type (`lastToolName: classified.itemType`,
 * `adapters/codex/normalise.ts`), a word or a thought included — neither of
 * which is ever a row of the child's.
 */
const NON_TOOL_ITEM_TYPES: ReadonlySet<string> = new Set([
  "user_message",
  "assistant_message",
  "reasoning",
  "plan",
  "review_entered",
  "review_exited",
  "context_compaction",
  "error",
  "unknown"
]);

/**
 * The roster row says the agent did real tool work — a tool's name as its last
 * tool (never a Codex word or thought tick), or a tool-use count above zero —
 * and a tool call is a row of the agent's own on every provider.
 */
export function didToolWork(agent: Pick<RuntimeSubagent, "lastToolName" | "usage">): boolean {
  const tool = agent.lastToolName?.trim();
  return (
    (tool !== undefined && tool.length > 0 && !NON_TOOL_ITEM_TYPES.has(tool)) ||
    (agent.usage?.toolUses ?? 0) > 0
  );
}

/**
 * The drill-in's notice, or null when a row of the agent's own is on screen.
 * `agent` is the drilled roster row, absent when the roster dropped it;
 * `retentionDropped` says the thread's window has dropped rows.
 */
export function drillInEmptyNotice(input: {
  rows: readonly AgentChatTimelineRow[];
  agent: RuntimeSubagent | undefined;
  retentionDropped: boolean;
}): EmptyNotice | null {
  const { rows, agent, retentionDropped } = input;
  if (rows.some((row) => !isPromptRow(row) && !isLivePlaceholder(row))) {
    return null;
  }
  const firstOwn = rows.findIndex((row) => !isPromptRow(row));
  const at = firstOwn < 0 ? rows.length : firstOwn;
  const notice = (text: string): EmptyNotice => ({ text, at });
  if (agent !== undefined && isLoopOrGoalRow(agent)) {
    // A loop and a goal print nothing: their work is rows of their own.
    return notice(
      agent.kind === "loop"
        ? "Each fire runs as an agent of its own, in the roster."
        : "A goal's work runs in the thread's own turns and the agents it starts."
    );
  }
  // Live by its roster status (`pending`, `running`, `waiting`), which the
  // roster fold already settles when the session dies — the notion the
  // drill-in's live rows follow too.
  const live = agent !== undefined && ACTIVE_SUBAGENT_STATUSES.has(agent.status);
  const left = agent !== undefined && retentionDropped && didToolWork(agent);
  if (agent?.agentKind === "background") {
    // A shell prints output, it does not "report".
    if (live) {
      return notice("No output yet.");
    }
    return notice(left ? "Its output has left this thread's window." : "No output from this shell is in this thread.");
  }
  if (live) {
    return notice("This agent has not reported anything yet.");
  }
  return notice(left ? "Its earlier rows have left this thread's window." : "This agent reported nothing to show here.");
}
