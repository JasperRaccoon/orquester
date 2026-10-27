/**
 * The chat's Tools chip (unified MCP §7.6) — the pure half: the chip's text. Every Orquester tool
 * is on in every chat, so the chip is about the grants that apply to this chat (and, for a chat a
 * workflow runs, why it has no Admin tools).
 *
 * No React import.
 */

import type { ThreadAgentToolsResponse } from "@orquester/api";

export interface ToolsChipModel {
  /** "Tools", or "Tools · 2" with grants. */
  label: string;
  /** The tooltip. */
  title: string;
  /** Spoken name of the trigger. */
  ariaLabel: string;
  /** Grants that apply to this chat (its own and its project's). */
  grantCount: number;
  /** Why this chat cannot have Admin tools or cards. */
  note: string | null;
}

export function deriveToolsChip(data: ThreadAgentToolsResponse): ToolsChipModel {
  const grantCount = data.grants.length;
  const grants = grantCount === 0 ? "no grants" : `${grantCount} grant${grantCount === 1 ? "" : "s"}`;
  return {
    label: grantCount === 0 ? "Tools" : `Tools · ${grantCount}`,
    title: `Every Orquester tool is available in this chat · ${grants}`,
    ariaLabel: `Orquester tools: all available, ${grants}`,
    grantCount,
    note: data.workflowOwned ? "A workflow runs this chat: it gets no Admin tools and no approval cards." : null
  };
}
