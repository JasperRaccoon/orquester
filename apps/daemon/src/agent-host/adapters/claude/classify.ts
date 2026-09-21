/**
 * Claude adapter — tool classification and one-line summaries (spec §4.2,
 * §4.3).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/Layers/ClaudeAdapter.ts`
 * (`classifyToolItemType`, `isReadOnlyToolName`, `classifyRequestType`,
 * `summarizeToolRequest`, `titleForTool`), translated from Effect into plain
 * TypeScript and corrected against the real CLI (see the notes below).
 */

import type { CanonicalItemType, CanonicalRequestType } from "@orquester/api/agent-chat";

/** Extensions the image viewer can render, so a `Read` of one is `image_view`. */
const IMAGE_PREVIEW_EXTENSIONS = new Set([
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
  ".bmp",
  ".svg"
]);

/**
 * The step-list tools of CLI 2.1.210. They are **not** `TodoWrite`
 * (fixtures/claude README observation 3) and they are not file changes either:
 * T3's substring ladder lands `TaskCreate` on `file_change` because the name
 * contains "create", which would badge a to-do row as an edit.
 */
export const CLAUDE_STEP_LIST_TOOLS: ReadonlySet<string> = new Set([
  "TaskCreate",
  "TaskUpdate",
  "TaskList"
]);

/** The subagent-spawning tool. `Agent` on this CLI, `Task` on older ones. */
export function isSubagentTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return normalized === "agent" || normalized === "task";
}

export function isStepListTool(toolName: string): boolean {
  return CLAUDE_STEP_LIST_TOOLS.has(toolName.trim());
}

/**
 * The legacy to-do tool. Kept so a fixture or an older CLI that still emits
 * `TodoWrite {todos:[…]}` keeps producing `turn.plan.updated`.
 */
export function isTodoTool(toolName: string): boolean {
  return toolName.toLowerCase().includes("todowrite");
}

export function readToolImagePath(
  toolName: string,
  input: Record<string, unknown>
): string | undefined {
  const normalized = toolName.trim().toLowerCase();
  if (normalized !== "read" && normalized !== "read file") {
    return undefined;
  }
  const raw = input.file_path ?? input.path;
  if (typeof raw !== "string") {
    return undefined;
  }
  const value = raw.trim();
  if (value.length === 0) {
    return undefined;
  }
  const dot = value.lastIndexOf(".");
  if (dot < 0) {
    return undefined;
  }
  return IMAGE_PREVIEW_EXTENSIONS.has(value.slice(dot).toLowerCase()) ? value : undefined;
}

/**
 * Tool name (plus its input, where the input decides) → the closed
 * `CanonicalItemType` of §4.2.
 *
 * *differs from T3:* the step-list tools and `ToolSearch` get explicit arms
 * ahead of the substring ladder. T3's ladder classifies `TaskCreate` as
 * `file_change` (it contains "create") and `ToolSearch` as a plain dynamic
 * call by accident rather than by decision; both are live tools on CLI
 * 2.1.210.
 */
export function classifyToolItemType(
  toolName: string,
  input: Record<string, unknown> = {}
): CanonicalItemType {
  if (readToolImagePath(toolName, input)) {
    return "image_view";
  }
  if (isStepListTool(toolName) || toolName.trim() === "ToolSearch") {
    return "dynamic_tool_call";
  }
  const normalized = toolName.toLowerCase();
  if (
    normalized.includes("agent") ||
    normalized === "task" ||
    normalized.includes("subagent") ||
    normalized.includes("sub-agent")
  ) {
    return "collab_agent_tool_call";
  }
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("websearch") || normalized.includes("web search")) {
    return "web_search";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  return "dynamic_tool_call";
}

export function isReadOnlyToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized === "read" ||
    normalized.includes("read file") ||
    normalized.includes("view") ||
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("search")
  );
}

/**
 * The canonical request type an approval card is filed under (§4.3). There is
 * no plan-exit kind: `ExitPlanMode` never reaches here because it is answered
 * before any approval logic, and an MCP tool lands on `permission_approval`.
 */
export function classifyRequestType(toolName: string): CanonicalRequestType {
  if (isReadOnlyToolName(toolName)) {
    return "file_read_approval";
  }
  const itemType = classifyToolItemType(toolName);
  switch (itemType) {
    case "command_execution":
      return "command_execution_approval";
    case "file_change":
      return "file_change_approval";
    case "mcp_tool_call":
      return "permission_approval";
    default:
      return "dynamic_tool_call";
  }
}

export function titleForTool(itemType: CanonicalItemType): string {
  switch (itemType) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "dynamic_tool_call":
      return "Tool call";
    default:
      return "Item";
  }
}

/** The streamed-output kind a tool result's text belongs to, if any. */
export function toolResultStreamKind(
  itemType: CanonicalItemType
): "command_output" | "file_change_output" | undefined {
  if (itemType === "command_execution") {
    return "command_output";
  }
  if (itemType === "file_change") {
    return "file_change_output";
  }
  return undefined;
}

const SUMMARY_MAX_CHARS = 400;

export function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * The one-line detail an activity row and an approval card show. The
 * provider's own `description` beats anything reconstructed here, so the
 * caller prefers `canUseTool`'s `description` when it has one (fixtures README
 * observation 11).
 */
export function summarizeToolRequest(toolName: string, input: Record<string, unknown>): string {
  const imagePath = readToolImagePath(toolName, input);
  if (imagePath) {
    return imagePath;
  }

  const commandValue = input.command ?? input.cmd;
  if (typeof commandValue === "string" && commandValue.trim().length > 0) {
    return `${toolName}: ${commandValue.trim().slice(0, SUMMARY_MAX_CHARS)}`;
  }

  if (classifyToolItemType(toolName) === "collab_agent_tool_call") {
    const description = typeof input.description === "string" ? input.description.trim() : "";
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    const label = description.length > 0 ? description : prompt.slice(0, 200);
    if (label.length > 0) {
      return label;
    }
  }

  const serialized = safeJson(input) ?? "[unserializable input]";
  if (serialized.length <= SUMMARY_MAX_CHARS) {
    return `${toolName}: ${serialized}`;
  }
  return `${toolName}: ${serialized.slice(0, SUMMARY_MAX_CHARS - 3)}...`;
}

/**
 * A `tool_result` the CLI itself refused, with no approval behind it. The CLI
 * gates first and silently (fixtures README observation 1): the only marker is
 * an error result whose text opens with `<tool_use_error>`, so the timeline
 * would otherwise render a policy denial as an ordinary tool failure.
 */
const TOOL_USE_ERROR_PREFIX = "<tool_use_error>";

export function isCliDenialResult(isError: boolean, text: string): boolean {
  return isError && text.trimStart().startsWith(TOOL_USE_ERROR_PREFIX);
}

/** The denial sentence without the `<tool_use_error>` wrapper. */
export function cliDenialReason(text: string): string {
  const trimmed = text.trim();
  const withoutOpen = trimmed.startsWith(TOOL_USE_ERROR_PREFIX)
    ? trimmed.slice(TOOL_USE_ERROR_PREFIX.length)
    : trimmed;
  const close = withoutOpen.lastIndexOf("</tool_use_error>");
  return (close >= 0 ? withoutOpen.slice(0, close) : withoutOpen).trim();
}

/** Stable fingerprint of a parsed tool input, to suppress duplicate updates. */
export function toolInputFingerprint(input: Record<string, unknown>): string | undefined {
  return safeJson(input);
}

export function tryParseJsonRecord(value: string): Record<string, unknown> | undefined {
  if (value.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

/** Only http/https survive; anything else (`javascript:`, `file:`, …) is dropped. */
export function sanitizeSessionUrl(value: unknown): string | undefined {
  const trimmed = trimmedString(value);
  return trimmed !== undefined && /^https?:\/\//i.test(trimmed) ? trimmed : undefined;
}

/**
 * Text out of a `tool_result` block's `content`, which is either a string or
 * an array of content blocks.
 */
export function extractTextContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  const parts: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      parts.push(entry);
      continue;
    }
    if (entry !== null && typeof entry === "object") {
      const block = entry as { type?: unknown; text?: unknown };
      if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
  }
  return parts.join("");
}
