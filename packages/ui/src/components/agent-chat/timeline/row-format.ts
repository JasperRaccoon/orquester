/**
 * Pure row-formatting rules (spec §7.3).
 *
 * Everything a row *decides* rather than *draws* lives here, so it can be
 * unit-tested without a DOM and without dragging the store, `react-markdown`
 * and the CodeMirror grammars into a node test run. The components in `rows/`
 * import from this file; nothing here imports a component.
 */

import type { RuntimeSubagent } from "@orquester/api";

import type { AgentChatTimelineRow } from "../../../lib/agent-chat/contracts";

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
export function compactionLabel(row: Pick<Row<"context-compaction">, "label" | "beforeTokens" | "afterTokens">): string {
  const { beforeTokens, afterTokens } = row;
  if (typeof beforeTokens === "number" && typeof afterTokens === "number") {
    return `${row.label} · ${formatTokenCount(beforeTokens)} → ${formatTokenCount(afterTokens)} tokens`;
  }
  return row.label;
}


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


const ACTIVE_STATUSES = new Set<RuntimeSubagent["status"]>(["pending", "running", "waiting"]);
const TERMINAL_STATUSES = new Set<RuntimeSubagent["status"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted"
]);

export interface AgentSpawnSummary {
  live: boolean;
  lead: string;
  status: string;
  tone: "working" | "failed" | "completed" | "inactive";
}

/**
 * Summarises observed states **without treating idle or missing agents as
 * completed** — the row says "Status unavailable" rather than inventing a tick.
 * *T3: `agentSpawnSummary.ts:8-64`.*
 */
export function deriveAgentSpawnSummary(input: {
  agents: ReadonlyArray<Pick<RuntimeSubagent, "kind" | "status">>;
  agentCount: number;
  coordinatorStatus?: RuntimeSubagent["status"] | undefined;
}): AgentSpawnSummary {
  const { agents, agentCount, coordinatorStatus } = input;
  const working = agents.filter((agent) => ACTIVE_STATUSES.has(agent.status)).length;
  const failed = agents.filter((agent) => agent.status === "failed").length;
  const idle = agents.filter((agent) => agent.status === "idle").length;
  const stopped = agents.filter(
    (agent) => agent.status === "cancelled" || agent.status === "interrupted"
  ).length;
  const batches = agents.filter((agent) => agent.kind === "subagent_batch").length;
  const individuals = agentCount - batches;
  // A workflow coordinator keeps running between dynamic member launches.
  const live = coordinatorStatus !== undefined ? !TERMINAL_STATUSES.has(coordinatorStatus) : working > 0;
  const subjects = [
    individuals > 0 ? `${individuals} subagent${individuals === 1 ? "" : "s"}` : null,
    batches > 0 ? `${batches} ${individuals > 0 ? "" : "subagent "}batch${batches === 1 ? "" : "es"}` : null
  ]
    .filter((value) => value !== null)
    .join(" and ");
  const lead = `${batches > 0 ? "Launched" : live ? "Kicked off" : "Ran"} ${subjects || "subagents"}`;

  const status = live
    ? working > 0
      ? `${working} working`
      : "working"
    : coordinatorStatus === "failed"
      ? "Workflow failed"
      : coordinatorStatus === "cancelled" || coordinatorStatus === "interrupted"
        ? "Workflow stopped"
        : failed > 0
          ? `${failed} failed`
          : stopped > 0
            ? `${stopped} stopped`
            : idle > 0
              ? `${idle} idle`
              : coordinatorStatus !== "completed" && (agents.length === 0 || agents.length < agentCount)
                ? "Status unavailable"
                : "✓ completed";
  const tone: AgentSpawnSummary["tone"] = live
    ? "working"
    : failed > 0 || coordinatorStatus === "failed"
      ? "failed"
      : status === "✓ completed"
        ? "completed"
        : "inactive";
  return { live, lead, status, tone };
}

