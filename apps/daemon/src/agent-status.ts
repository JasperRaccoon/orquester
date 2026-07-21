import type { AgentEventSource } from "@orquester/api";
import type { HookEventClass } from "./ansi-activity";

/**
 * Maps a raw agent hook event to an activity class. Mapping mirrors what each
 * CLI actually emits (see the design spec's table); unknown events return null
 * and are ignored — a hook must never be able to break a session.
 */
export function classifyAgentEvent(
  source: AgentEventSource,
  event: string,
  payload: unknown
): HookEventClass | null {
  switch (source) {
    case "claude":
      return classifyClaude(event, payload);
    case "codex":
      return classifyCodex(event);
    case "opencode":
      return classifyOpenCode(event);
  }
}

function toolName(payload: unknown): string {
  return typeof (payload as { tool_name?: unknown })?.tool_name === "string"
    ? ((payload as { tool_name: string }).tool_name)
    : "";
}

/** Claude auto-allows AskUserQuestion, so it never reaches PermissionRequest. */
function isAskUserQuestion(payload: unknown): boolean {
  return toolName(payload) === "AskUserQuestion";
}

function isPermissionNotification(payload: unknown): boolean {
  const message = (payload as { message?: unknown })?.message;
  return typeof message === "string" && /permission|approv|waiting for your input/i.test(message);
}

function classifyClaude(event: string, payload: unknown): HookEventClass | null {
  switch (event) {
    case "UserPromptSubmit":
    case "PostToolUse":
      return "working";
    case "PreToolUse":
      return isAskUserQuestion(payload) ? "waiting" : "working";
    case "PermissionRequest":
      return "waiting";
    case "Notification":
      return isPermissionNotification(payload) ? "waiting" : null;
    case "Stop":
      return "done";
    default:
      return null;
  }
}

function classifyCodex(event: string): HookEventClass | null {
  switch (event) {
    case "SessionStart":
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse":
      return "working";
    case "PermissionRequest":
      return "waiting";
    case "Stop":
      return "done";
    default:
      return null;
  }
}

function classifyOpenCode(event: string): HookEventClass | null {
  switch (event) {
    case "SessionBusy":
      return "working";
    case "PermissionRequest":
    case "AskUserQuestion":
      return "waiting";
    case "SessionIdle":
      return "done";
    default:
      return null;
  }
}
