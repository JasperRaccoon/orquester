/**
 * The chat's Tools chip (unified MCP §9.2) — the pure half: which toolsets are on in this chat and
 * why (its own override, else the agent's default), what a choice sends, and the chip's text.
 *
 * No React import. Tested by `tools-chip.test.ts`.
 */

import {
  TOOLSETS,
  type ThreadAgentToolsResponse,
  type ToolsetId,
  type ToolsetSpec,
  type UpdateThreadAgentToolsRequest
} from "@orquester/api";

export type ToolsetChoice = "inherit" | "on" | "off";

export interface ToolsChipRow {
  id: ToolsetId;
  label: string;
  locked: boolean;
  toolCount: number;
  /** This chat's own choice; `inherit` = the agent's default. */
  choice: ToolsetChoice;
  /** On in this chat now. */
  on: boolean;
  /**
   * What the agent's default gives: known only while the chat inherits it (= `on`); with an
   * override the chat's answer does not say (Settings may differ from the catalogue), so null.
   */
  inheritedOn: boolean | null;
  /** The user denied this toolset on a card in this chat; the agent may ask again from then (ISO). */
  declinedUntil: string | null;
}

export interface ToolsChipModel {
  /** "Tools 22": the tools this chat's agent is offered. */
  label: string;
  /** The tooltip: the toolsets that are on. */
  title: string;
  /** Spoken name of the trigger. */
  ariaLabel: string;
  toolCount: number;
  rows: ToolsChipRow[];
  /** A change waits for the chat's next idle point. */
  pending: boolean;
  /** Why this chat cannot have Admin tools or cards. */
  note: string | null;
}

/**
 * The chip from the chat's toolsets. Resolution is the daemon's (`resolved`: chat override → the
 * agent's default; `core` locked); the rows say how each got there. Toolsets this build does not
 * know are not listed.
 */
export function deriveToolsChip(
  data: ThreadAgentToolsResponse,
  now: number,
  toolsets: readonly ToolsetSpec[] = TOOLSETS
): ToolsChipModel {
  const resolved = new Set<ToolsetId>(data.resolved);
  const rows: ToolsChipRow[] = toolsets.map((toolset) => {
    const override = data.overrides[toolset.id];
    const on = toolset.locked || resolved.has(toolset.id);
    const until = data.declines[toolset.id];
    const declinedUntil = until !== undefined && Date.parse(until) > now ? until : null;
    return {
      id: toolset.id,
      label: toolset.label,
      locked: toolset.locked,
      toolCount: toolset.tools.length,
      choice: toolset.locked || override === undefined ? "inherit" : override ? "on" : "off",
      on,
      inheritedOn: toolset.locked || override === undefined ? on : null,
      declinedUntil
    };
  });
  const onRows = rows.filter((row) => row.on);
  const toolCount = onRows.reduce((sum, row) => sum + row.toolCount, 0);
  return {
    label: `Tools ${toolCount}`,
    title: `Orquester tools on in this chat: ${onRows.map((row) => row.label).join(", ")}`,
    ariaLabel: `Orquester tools: ${toolCount} tools in ${onRows.length} toolset${onRows.length === 1 ? "" : "s"}${data.appliesAtNextIdle ? ", a change applies at the next idle point" : ""}`,
    toolCount,
    rows,
    pending: data.appliesAtNextIdle,
    note: data.workflowOwned ? "A workflow runs this chat: it gets no Admin tools and no approval cards." : null
  };
}

/** What choosing `choice` for a toolset sends (`null` = inherit); null for a locked one. */
export function toolsetChoiceUpdate(row: Pick<ToolsChipRow, "id" | "locked">, choice: ToolsetChoice): UpdateThreadAgentToolsRequest | null {
  if (row.locked) return null;
  return { toolsets: { [row.id]: choice === "inherit" ? null : choice === "on" } };
}

/** "10:42" — when a declined toolset may be asked for again. */
export function formatDeclinedUntil(until: string): string {
  const date = new Date(until);
  return Number.isNaN(date.getTime()) ? until : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
