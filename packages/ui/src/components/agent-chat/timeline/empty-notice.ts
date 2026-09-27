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
 *  - its rows have LEFT the window only with evidence of both halves — the
 *    thread's window has dropped rows (`retentionDropped`,
 *    `windowHasDropped`) and the agent did real tool work, which leaves rows
 *    ({@link didToolWork}) — whether it is live or settled: a fleet agent
 *    still at work can lose every row to the cross-agent ceiling, and "not
 *    reported anything yet" was then untrue (fix round 2's amended ruling);
 *  - otherwise a LIVE agent has not reported anything yet (its live rows sit
 *    under the line);
 *  - and a settled one reads a neutral line that is true whatever happened.
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

import type { CanonicalItemType, RuntimeSubagent, ToolLifecycleItemType } from "@orquester/api/agent-chat";
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
 * Every canonical item type that is no tool, as a record: `satisfies` makes
 * the compiler name a member of `CanonicalItemType` added without a verdict
 * here, and refuse a tool type (`TOOL_LIFECYCLE_ITEM_TYPES`) listed as none.
 */
const NON_TOOL_ITEM_TYPE_RECORD = {
  user_message: true,
  assistant_message: true,
  reasoning: true,
  plan: true,
  review_entered: true,
  review_exited: true,
  context_compaction: true,
  error: true,
  unknown: true
} as const satisfies Record<Exclude<CanonicalItemType, ToolLifecycleItemType>, true>;

/**
 * The item types a roster tick can name as the "last tool" that are no tool:
 * Codex's child tick carries the ITEM type (`lastToolName: classified.itemType`,
 * `adapters/codex/normalise.ts`), a word or a thought included — neither of
 * which is ever a row of the child's. Exactly the canonical item types that
 * are not `TOOL_LIFECYCLE_ITEM_TYPES`, by construction.
 */
export const NON_TOOL_ITEM_TYPES: ReadonlySet<string> = new Set(Object.keys(NON_TOOL_ITEM_TYPE_RECORD));

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
 * `agent` is the drilled row, absent when there is none at all;
 * `retentionDropped` says the thread's window has dropped rows;
 * `backgroundShell` says it is a shell's drill-in — the row's kind, or, with
 * no row, the items' (`isBackgroundShellItems`). Absent: the row's kind.
 * `agentRemembered` says the row is the one last seen, not the roster's: its
 * kind and its work still count, its status does not — it is never live.
 */
export function drillInEmptyNotice(input: {
  rows: readonly AgentChatTimelineRow[];
  agent: RuntimeSubagent | undefined;
  retentionDropped: boolean;
  backgroundShell?: boolean;
  agentRemembered?: boolean;
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
  // Its rows left only with both kinds of evidence, live or settled.
  const left = agent !== undefined && retentionDropped && didToolWork(agent);
  // Live by its roster status (`pending`, `running`, `waiting`), which the
  // roster fold already settles when the session dies — the notion the
  // drill-in's live rows follow too. A remembered row is not the roster's: its
  // status is not current, and the timeline reads it as not live.
  const live = agent !== undefined && input.agentRemembered !== true && ACTIVE_SUBAGENT_STATUSES.has(agent.status);
  if (input.backgroundShell ?? agent?.agentKind === "background") {
    // A shell prints output, it does not "report".
    if (left) {
      return notice("Its output has left this thread's window.");
    }
    return notice(live ? "No output yet." : "No output from this shell is in this thread.");
  }
  if (left) {
    return notice("Its earlier rows have left this thread's window.");
  }
  return notice(live ? "This agent has not reported anything yet." : "This agent reported nothing to show here.");
}

/** The notice's key among the rows: no row id takes this shape. */
export const TIMELINE_NOTICE_KEY = "timeline-empty-notice";

/** One child of the timeline's list: a row, or the empty notice. */
export type TimelineSlot =
  | { readonly key: string; readonly row: AgentChatTimelineRow }
  | { readonly key: typeof TIMELINE_NOTICE_KEY; readonly notice: EmptyNotice };

/**
 * The timeline's children, as ONE keyed list: the rows, with the notice
 * spliced in at its place. Rendered as separate arrays around it, a row that
 * crossed the notice — a live agent's working row, the moment its first own row
 * lands and the notice goes — moved to another array and remounted, replaying
 * its rise; §7.3 wants the working row swapped in place, never remounted.
 */
export function timelineSlots(rows: readonly AgentChatTimelineRow[], notice: EmptyNotice | null): TimelineSlot[] {
  const slots: TimelineSlot[] = [];
  rows.forEach((row, index) => {
    if (notice !== null && index === notice.at) {
      slots.push({ key: TIMELINE_NOTICE_KEY, notice });
    }
    slots.push({ key: row.id, row });
  });
  if (notice !== null && notice.at >= rows.length) {
    slots.push({ key: TIMELINE_NOTICE_KEY, notice });
  }
  return slots;
}

/**
 * The timeline's children, as ONE keyed array (see {@link timelineSlots}):
 * each row rendered under its id, the notice under {@link TIMELINE_NOTICE_KEY}
 * at its place. The keys are this function's, never the callers': with no
 * notice — every thread with a row — the rows are mapped directly, under
 * exactly the keys and in exactly the order the slots give them, so no row
 * remounts when a notice comes or goes, and a token allocates no slot object
 * per row (the slots cost ~62 µs a token at 2 500 rows; final review C, O1).
 */
export function timelineChildren<T>(
  rows: readonly AgentChatTimelineRow[],
  notice: EmptyNotice | null,
  renderRow: (row: AgentChatTimelineRow, key: string) => T,
  renderNotice: (notice: EmptyNotice, key: string) => T
): T[] {
  if (notice === null) {
    return rows.map((row) => renderRow(row, row.id));
  }
  return timelineSlots(rows, notice).map((slot) =>
    "row" in slot ? renderRow(slot.row, slot.key) : renderNotice(slot.notice, slot.key)
  );
}
