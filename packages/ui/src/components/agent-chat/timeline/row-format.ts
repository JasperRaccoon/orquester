/**
 * Pure row-formatting rules (spec §7.3).
 *
 * Everything a row *decides* rather than *draws* lives here, so it can be
 * unit-tested without a DOM and without dragging the store, `react-markdown`
 * and the CodeMirror grammars into a node test run. The components in `rows/`
 * import from this file; nothing here imports a component.
 */

import type { AgentChatTimelineRow } from "../../../lib/agent-chat/contracts";
import { isCompactCommandMessage } from "./row-chrome";

type Row<K extends AgentChatTimelineRow["kind"]> = Extract<AgentChatTimelineRow, { kind: K }>;

/**
 * Vertical rhythm is **bottom padding on the row shell**, not a `gap` on the
 * list, so each row kind declares its own relationship to the next one.
 *
 * The pattern is the whole point: *activity rows cling together (8px),
 * conversation turns breathe (16px)*. A stream of twenty tool calls should read
 * as one block of work, not as twenty separate events.
 * *T3: `MessagesTimeline.tsx:1669-1701`.*
 */
export function rowBottomPadding(row: AgentChatTimelineRow): string {
  // A `/compact` submission renders as a marker, not a bubble (§4.6.5(b)), so
  // it takes the marker's spacing too — otherwise a hairline sits in a 16px
  // conversation gap and reads as a turn boundary.
  if (row.kind === "message" && isCompactCommandMessage(row.message)) return "pb-2";
  if (row.kind === "work" && row.isExpandedToolGroup) return "pb-1";
  if ((row.kind === "work-toggle" || row.kind === "work-live") && row.expanded) return "pb-0";
  if (row.kind === "turn-fold" || row.kind === "working") return "pb-1.5";
  if (
    (row.kind === "message" && row.message.role === "assistant" && !row.showAssistantMeta) ||
    (row.kind === "message" && row.message.role === "reasoning") ||
    row.kind === "work" ||
    row.kind === "work-live" ||
    row.kind === "work-toggle" ||
    row.kind === "activity-group" ||
    row.kind === "thinking"
  ) {
    return "pb-2";
  }
  return "pb-4";
}


/** Compact token counts: `128k`, `12.4k`, `840`. */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "0";
  if (tokens < 1000) return String(Math.round(tokens));
  const thousands = tokens / 1000;
  return thousands >= 100 ? `${Math.round(thousands)}k` : `${thousands.toFixed(1).replace(/\.0$/, "")}k`;
}

/**
 * The compaction label.
 *
 * DELIBERATE DIFFERENCE FROM T3: T3 bakes the before/after counts into the
 * label server-side and the row never sees the numbers
 * (`ProviderRuntimeIngestion.ts:863-868`). We carry `beforeTokens`/`afterTokens`
 * on the event and format here, so the same event renders in whatever unit the
 * client prefers and an older row without numbers still reads correctly.
 */
export function compactionLabel(
  row: Pick<Row<"context-compaction">, "label" | "beforeTokens" | "afterTokens" | "failed">
): string {
  const { beforeTokens, afterTokens } = row;
  // A failed compaction left the conversation unchanged, so any counts on it
  // describe a saving that never happened. Never spell them.
  if (row.failed !== true && typeof beforeTokens === "number" && typeof afterTokens === "number") {
    return `${row.label} · ${formatTokenCount(beforeTokens)} → ${formatTokenCount(afterTokens)} tokens`;
  }
  return row.label;
}

/**
 * What the live placeholders say while the provider rewrites the conversation.
 *
 * One constant because three surfaces show it — the working row, the thinking
 * placeholder and a live activity group's header — and a compaction that
 * spells itself differently in two places reads as two different things
 * happening.
 *
 * *T3: `MessagesTimeline.tsx:2875-2882` (`CompactingLabel`), which says
 * "Compacting…"; ours names the noun because our status line already carries
 * the short form and the timeline row has the width for it.*
 */
export const COMPACTING_LABEL = "Compacting context…";


export function proposedPlanTitle(markdown: string): string {
  const heading = /^#{1,6}\s+(.+)$/m.exec(markdown)?.[1]?.trim();
  if (heading !== undefined && heading.length > 0) return heading;
  const firstLine = markdown
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine !== undefined && firstLine.length > 0 ? firstLine.slice(0, 80) : "Proposed plan";
}

export function planFileName(markdown: string): string {
  const slug = proposedPlanTitle(markdown)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug.length > 0 ? slug : "plan"}.md`;
}


/** Over this the body clamps with a mask fade and a "Show full message" toggle. */
const USER_MESSAGE_CLAMP_CHARS = 600;
const USER_MESSAGE_CLAMP_LINES = 8;

export function shouldClampUserMessage(text: string): boolean {
  return text.length > USER_MESSAGE_CLAMP_CHARS || text.split("\n").length > USER_MESSAGE_CLAMP_LINES;
}


export function queuedStatusLabel(holdUntilUserAction: boolean, isNext: boolean): string {
  if (holdUntilUserAction) return "Waits for Send now";
  return isNext ? "Sends after the next tool call or when the turn ends" : "Sends after the messages above it";
}


/** Cheap enough to run on every expanded tool row; no parse involved. */
export function looksLikeUnifiedDiff(text: string): boolean {
  return /^diff --git /m.test(text) || (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(text) && /^[+-]/m.test(text));
}
