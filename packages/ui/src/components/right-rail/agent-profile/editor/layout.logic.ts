/**
 * The editor's layout decisions, as data: phone or desktop, wide or narrow,
 * and the header's title.
 */

import {
  AGENT_PROFILE_AGENT_LABELS,
  PROFILE_ITEM_KIND_LABELS,
  type AgentProfileAgentId,
  type ProfileItemKind
} from "@orquester/api";

/**
 * A phone: a narrow viewport, or a touch screen not much wider (a small tablet
 * in portrait) — the workflows editor's rule, so both full-screen editors
 * agree on the same device.
 */
export const EDITOR_PHONE_QUERY = "(max-width: 767px), ((pointer: coarse) and (max-width: 1023px))";

export type EditorVariant = "desktop" | "phone";

/** Key | value side by side from this editor width (px) up; stacked below. */
export const EDITOR_WIDE_PX = 520;

export function isWide(width: number): boolean {
  return width >= EDITOR_WIDE_PX;
}

/** What the editor assumes before it has measured itself (a static render, the first frame). */
export function assumedWidth(variant: EditorVariant): number {
  return variant === "phone" ? 360 : 680;
}

export function kindTitle(mode: "create" | "edit", kind: ProfileItemKind): string {
  const one = PROFILE_ITEM_KIND_LABELS[kind].one;
  // "MCP server" keeps its capitals; every other kind reads lower-case mid-sentence.
  const noun = kind === "mcp" ? one : one.toLowerCase();
  if (mode === "edit") return `Edit ${noun}`;
  if (kind === "plugin") return "Install a plugin";
  if (kind === "marketplace") return "Add a marketplace";
  return `New ${noun}`;
}

export function agentLabel(agent: AgentProfileAgentId): string {
  return AGENT_PROFILE_AGENT_LABELS[agent];
}
